// Package registry runs Dockhand's built-in image registry and keeps the
// credentials Dockhand uses for other registries.
//
// The registry itself is the CNCF distribution server (compose service
// "registry", not published). Dockhand serves it at /v2/ on its own port with
// its own authentication in front: Dockhand users (push + pull) and registry
// access tokens (pull or push). Hosts pull with a system token Dockhand keeps.
package registry

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"dockhand/internal/auth"
	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/regauth"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
)

const systemTokenKey = "registry_system_token" // settings row: encrypted system token

type Service struct {
	cfg      *config.Config
	db       *db.DB
	box      *secret.Box
	settings *settings.Store
	auth     *auth.Service
	jobs     *jobs.Runner

	upstream *url.URL
	proxy    *httputil.ReverseProxy
	http     *http.Client

	// IP returns the client address for rate limiting (set by the API, which knows which proxies to trust).
	IP func(*http.Request) string

	mu        sync.Mutex
	okCache   map[string]authResult // sha256(user:pass) → result, so pushes don't bcrypt every request
	sysToken  string
	lastTouch map[string]time.Time
}

type authResult struct {
	scope   string // pull | push
	who     string
	tokenID string
	until   time.Time
}

func New(cfg *config.Config, pool *db.DB, box *secret.Box, st *settings.Store, a *auth.Service, jr *jobs.Runner) *Service {
	up, err := url.Parse(cfg.RegistryURL)
	if err != nil || up.Host == "" {
		up, _ = url.Parse("http://registry:5000")
	}
	s := &Service{cfg: cfg, db: pool, box: box, settings: st, auth: a, jobs: jr, upstream: up,
		http: &http.Client{Timeout: 30 * time.Second}, okCache: map[string]authResult{}, lastTouch: map[string]time.Time{}}
	rp := httputil.NewSingleHostReverseProxy(up)
	base := rp.Director
	rp.Director = func(r *http.Request) {
		base(r)
		r.Host = up.Host
		r.Header.Del("Authorization")
		r.Header.Del("Cookie")
	}
	rp.FlushInterval = -1 // stream layer uploads and downloads
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Warn("registry proxy", "path", r.URL.Path, "err", err)
		regError(w, http.StatusBadGateway, "UNAVAILABLE", "Dockhand's registry service isn't answering")
	}
	s.proxy = rp
	return s
}

// ─── Address ────────────────────────────────────────────────────────────────

// Address is the registry's name for docker login/tag/push: the setting, or
// the host[:port] of Dockhand's public URL.
func (s *Service) Address() string {
	if a := s.settings.Get().Registry.Address; a != "" {
		return strings.ToLower(a)
	}
	u, err := url.Parse(s.settings.Get().General.PublicURL)
	if err != nil || u.Host == "" {
		u, _ = url.Parse(s.cfg.PublicURL)
	}
	if u == nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Host)
}

// Secure reports whether clients reach the registry over HTTPS.
func (s *Service) Secure() bool {
	pub := s.settings.Get().General.PublicURL
	if pub == "" {
		pub = s.cfg.PublicURL
	}
	return strings.HasPrefix(strings.ToLower(pub), "https://")
}

// ─── regauth.Source ─────────────────────────────────────────────────────────

// Lookup implements regauth.Source.
func (s *Service) Lookup(ctx context.Context, server string) (regauth.Cred, bool) {
	server = regauth.Normalize(server)
	if s.settings.Get().Registry.Enabled && server == s.Address() {
		if tok := s.systemToken(ctx); tok != "" {
			return regauth.Cred{Server: server, Username: "dockhand", Password: tok}, true
		}
	}
	var id, user, enc string
	err := s.db.QueryRow(ctx, `SELECT id::text, username, password_enc FROM registry_credentials WHERE server = $1`, server).Scan(&id, &user, &enc)
	if err != nil {
		return regauth.Cred{}, false
	}
	pass, err := s.box.Decrypt(enc)
	if err != nil {
		slog.Warn("registry credential", "server", server, "err", err)
		return regauth.Cred{}, false
	}
	s.touch("cred:"+id, `UPDATE registry_credentials SET last_used_at = now() WHERE id::text = $1`, id)
	return regauth.Cred{Server: server, Username: user, Password: pass}, true
}

// All implements regauth.Source.
func (s *Service) All(ctx context.Context) []regauth.Cred {
	out := []regauth.Cred{}
	if s.settings.Get().Registry.Enabled {
		if tok := s.systemToken(ctx); tok != "" && s.Address() != "" {
			out = append(out, regauth.Cred{Server: s.Address(), Username: "dockhand", Password: tok})
		}
	}
	rows, err := s.db.Query(ctx, `SELECT server, username, password_enc FROM registry_credentials ORDER BY server`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var c regauth.Cred
		var enc string
		if rows.Scan(&c.Server, &c.Username, &enc) != nil {
			continue
		}
		if p, err := s.box.Decrypt(enc); err == nil {
			c.Password = p
			out = append(out, c)
		}
	}
	return out
}

// Internal implements regauth.Source: Dockhand reaches its own registry directly.
func (s *Service) Internal(server string) string {
	if s.settings.Get().Registry.Enabled && regauth.Normalize(server) == s.Address() {
		return s.upstream.String()
	}
	return ""
}

// touch records last use at most once a minute per key.
func (s *Service) touch(key, sql, id string) {
	s.mu.Lock()
	if time.Since(s.lastTouch[key]) < time.Minute {
		s.mu.Unlock()
		return
	}
	s.lastTouch[key] = time.Now()
	s.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.db.Exec(ctx, sql, id)
	}()
}

// ─── Credentials for other registries ──────────────────────────────────────

func (s *Service) Credentials(ctx context.Context) ([]model.RegistryCredential, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, server, username, last_used_at, created_at FROM registry_credentials ORDER BY server`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.RegistryCredential{}
	for rows.Next() {
		var c model.RegistryCredential
		if err := rows.Scan(&c.ID, &c.Server, &c.Username, &c.LastUsedAt, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SaveCredential adds or replaces the credential for a server.
func (s *Service) SaveCredential(ctx context.Context, in model.RegistryCredentialInput) (model.RegistryCredential, error) {
	server := regauth.Normalize(in.Server)
	user := strings.TrimSpace(in.Username)
	if server == "" || strings.ContainsAny(server, " /") {
		return model.RegistryCredential{}, &dockerops.BadRequest{Msg: "enter the registry host, e.g. ghcr.io or registry.example.com:5000"}
	}
	if s.settings.Get().Registry.Enabled && server == s.Address() {
		return model.RegistryCredential{}, &dockerops.BadRequest{Msg: "that's Dockhand's own registry — hosts already pull from it with Dockhand's token"}
	}
	if user == "" || in.Password == "" {
		return model.RegistryCredential{}, &dockerops.BadRequest{Msg: "username and password (or access token) are required"}
	}
	enc, err := s.box.Encrypt(in.Password)
	if err != nil {
		return model.RegistryCredential{}, err
	}
	var c model.RegistryCredential
	err = s.db.QueryRow(ctx, `INSERT INTO registry_credentials (server, username, password_enc) VALUES ($1, $2, $3)
		ON CONFLICT (server) DO UPDATE SET username = EXCLUDED.username, password_enc = EXCLUDED.password_enc
		RETURNING id::text, server, username, last_used_at, created_at`, server, user, enc).
		Scan(&c.ID, &c.Server, &c.Username, &c.LastUsedAt, &c.CreatedAt)
	return c, err
}

func (s *Service) DeleteCredential(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM registry_credentials WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return dockerops.ErrNotFound
	}
	return nil
}

// TestCredential logs in to a registry with the given (or stored) credentials.
func (s *Service) TestCredential(ctx context.Context, in model.RegistryCredentialInput, id string) error {
	server, user, pass := regauth.Normalize(in.Server), strings.TrimSpace(in.Username), in.Password
	if id != "" {
		var enc string
		if err := s.db.QueryRow(ctx, `SELECT server, username, password_enc FROM registry_credentials WHERE id::text = $1`, id).Scan(&server, &user, &enc); err != nil {
			return err
		}
		p, err := s.box.Decrypt(enc)
		if err != nil {
			return err
		}
		pass = p
	}
	return checkLogin(ctx, server, user, pass)
}

// checkLogin performs the registry login handshake (GET /v2/, then Basic or a token request).
func checkLogin(ctx context.Context, server, user, pass string) error {
	host := server
	if host == "docker.io" {
		host = "registry-1.docker.io"
	}
	cl := &http.Client{Timeout: 15 * time.Second}
	var resp *http.Response
	var err error
	scheme := "https"
	for _, sc := range []string{"https", "http"} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sc+"://"+host+"/v2/", nil)
		resp, err = cl.Do(req)
		if err == nil {
			scheme = sc
			break
		}
	}
	if err != nil {
		return fmt.Errorf("can't reach %s: %w", host, err)
	}
	resp.Body.Close()
	challenge := resp.Header.Get("Www-Authenticate")
	switch {
	case resp.StatusCode == http.StatusOK:
		return nil // no login required
	case resp.StatusCode != http.StatusUnauthorized:
		return fmt.Errorf("%s answered HTTP %d — is this a container registry?", host, resp.StatusCode)
	case strings.HasPrefix(strings.ToLower(challenge), "basic"):
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+host+"/v2/", nil)
		req.SetBasicAuth(user, pass)
		r2, err := cl.Do(req)
		if err != nil {
			return err
		}
		r2.Body.Close()
		if r2.StatusCode == http.StatusOK {
			return nil
		}
		return errors.New("the registry rejected the username or password")
	case strings.HasPrefix(strings.ToLower(challenge), "bearer"):
		params := parseChallenge(challenge[len("bearer"):])
		if params["realm"] == "" {
			return errors.New("the registry's login challenge has no realm")
		}
		q := url.Values{}
		if params["service"] != "" {
			q.Set("service", params["service"])
		}
		q.Set("account", user)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, params["realm"]+"?"+q.Encode(), nil)
		req.SetBasicAuth(user, pass)
		r2, err := cl.Do(req)
		if err != nil {
			return err
		}
		r2.Body.Close()
		if r2.StatusCode == http.StatusOK {
			return nil
		}
		return errors.New("the registry rejected the username or password/token")
	}
	return fmt.Errorf("%s asked for an unsupported login method", host)
}

func parseChallenge(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			out[strings.ToLower(k)] = strings.Trim(v, `"`)
		}
	}
	return out
}

// ─── Access tokens for the built-in registry ───────────────────────────────

func newToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "dhr_" + base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// EnsureSystemToken creates the token hosts pull with, once.
func (s *Service) EnsureSystemToken(ctx context.Context) error {
	if s.systemToken(ctx) != "" {
		return nil
	}
	tok, err := newToken()
	if err != nil {
		return err
	}
	enc, err := s.box.Encrypt(tok)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE registry_tokens SET revoked_at = now() WHERE system AND revoked_at IS NULL`); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO registry_tokens (name, prefix, hash, scope, system) VALUES ('Dockhand hosts', $1, $2, 'pull', true)`, tok[:12], hashToken(tok)); err != nil {
		return err
	}
	if err := s.settings.PutRaw(ctx, systemTokenKey, enc); err != nil {
		return err
	}
	s.mu.Lock()
	s.sysToken = tok
	s.mu.Unlock()
	return nil
}

func (s *Service) systemToken(ctx context.Context) string {
	s.mu.Lock()
	t := s.sysToken
	s.mu.Unlock()
	if t != "" {
		return t
	}
	var enc string
	if ok, err := s.settings.GetRaw(ctx, systemTokenKey, &enc); err != nil || !ok || enc == "" {
		return ""
	}
	t, err := s.box.Decrypt(enc)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	s.sysToken = t
	s.mu.Unlock()
	return t
}

func (s *Service) Tokens(ctx context.Context) ([]model.RegistryToken, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, name, prefix, scope, system, last_used_at, created_at FROM registry_tokens
		WHERE revoked_at IS NULL ORDER BY system DESC, created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.RegistryToken{}
	for rows.Next() {
		var t model.RegistryToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.Scope, &t.System, &t.LastUsedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Service) CreateToken(ctx context.Context, name, scope string) (model.RegistryToken, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.RegistryToken{}, &dockerops.BadRequest{Msg: "give the token a name, e.g. \"GitHub Actions\""}
	}
	if scope != "pull" && scope != "push" {
		return model.RegistryToken{}, &dockerops.BadRequest{Msg: "scope must be pull or push"}
	}
	tok, err := newToken()
	if err != nil {
		return model.RegistryToken{}, err
	}
	t := model.RegistryToken{Name: name, Prefix: tok[:12], Scope: scope, Token: tok}
	err = s.db.QueryRow(ctx, `INSERT INTO registry_tokens (name, prefix, hash, scope) VALUES ($1, $2, $3, $4) RETURNING id::text, created_at`,
		name, t.Prefix, hashToken(tok), scope).Scan(&t.ID, &t.CreatedAt)
	return t, err
}

func (s *Service) RevokeToken(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `UPDATE registry_tokens SET revoked_at = now() WHERE id::text = $1 AND NOT system AND revoked_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return dockerops.ErrNotFound
	}
	s.mu.Lock()
	s.okCache = map[string]authResult{} // drop cached logins so the token stops working now
	s.mu.Unlock()
	return nil
}

// ─── /v2/ endpoint ──────────────────────────────────────────────────────────

func regError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"errors": []map[string]string{{"code": code, "message": msg}}})
}

// ServeHTTP serves the registry API at /v2/ with Dockhand's authentication.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.settings.Get().Registry.Enabled {
		regError(w, http.StatusNotFound, "UNSUPPORTED", "Dockhand's registry is turned off (Settings → Registries)")
		return
	}
	user, pass, ok := r.BasicAuth()
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="Dockhand registry"`)
		regError(w, http.StatusUnauthorized, "UNAUTHORIZED", "log in with your Dockhand username and password, or a registry token")
		return
	}
	ip := r.RemoteAddr
	if s.IP != nil {
		ip = s.IP(r)
	}
	lim := s.auth.Limiter()
	if !lim.Allowed("registry:" + ip) {
		regError(w, http.StatusTooManyRequests, "TOOMANYREQUESTS", "too many failed logins — try again in a few minutes")
		return
	}
	res, err := s.authenticate(r.Context(), user, pass)
	if err != nil {
		lim.Fail("registry:" + ip)
		w.Header().Set("WWW-Authenticate", `Basic realm="Dockhand registry"`)
		regError(w, http.StatusUnauthorized, "UNAUTHORIZED", "wrong username, password or token")
		return
	}
	write := r.Method != http.MethodGet && r.Method != http.MethodHead
	if write && res.scope != "push" {
		regError(w, http.StatusForbidden, "DENIED", "this token can only pull — create a push token in Settings → Registries")
		return
	}
	if write {
		slog.Info("registry write", "method", r.Method, "path", r.URL.Path, "user", res.who, "ip", ip)
	}
	s.proxy.ServeHTTP(w, r)
}

func (s *Service) authenticate(ctx context.Context, user, pass string) (authResult, error) {
	sum := sha256.Sum256([]byte(user + "\x00" + pass))
	key := hex.EncodeToString(sum[:])
	s.mu.Lock()
	if c, ok := s.okCache[key]; ok && time.Now().Before(c.until) {
		s.mu.Unlock()
		if c.tokenID != "" {
			s.touch("tok:"+c.tokenID, `UPDATE registry_tokens SET last_used_at = now() WHERE id::text = $1`, c.tokenID)
		}
		return c, nil
	}
	s.mu.Unlock()
	var res authResult
	if strings.HasPrefix(pass, "dhr_") {
		var id, name, scope string
		err := s.db.QueryRow(ctx, `SELECT id::text, name, scope FROM registry_tokens WHERE hash = $1 AND revoked_at IS NULL`, hashToken(pass)).Scan(&id, &name, &scope)
		if err != nil {
			return res, errors.New("bad token")
		}
		res = authResult{scope: scope, who: "token:" + name, tokenID: id}
		s.touch("tok:"+id, `UPDATE registry_tokens SET last_used_at = now() WHERE id::text = $1`, id)
	} else {
		u, err := s.auth.Login(ctx, user, pass)
		if err != nil {
			return res, err
		}
		res = authResult{scope: "push", who: u.Username}
	}
	res.until = time.Now().Add(5 * time.Minute)
	s.mu.Lock()
	if len(s.okCache) > 500 {
		s.okCache = map[string]authResult{}
	}
	s.okCache[key] = res
	s.mu.Unlock()
	return res, nil
}

// ─── Browsing (Dockhand → registry service, no auth) ───────────────────────

func (s *Service) get(ctx context.Context, path string, accept string, dst any) (http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.upstream.String()+path, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return resp.Header, fmt.Errorf("registry: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if dst == nil {
		return resp.Header, nil
	}
	return resp.Header, json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(dst)
}

// Info reports the registry's state.
func (s *Service) Info(ctx context.Context) model.RegistryInfo {
	info := model.RegistryInfo{Enabled: s.settings.Get().Registry.Enabled, Address: s.Address(), Secure: s.Secure(), Size: -1}
	repos, err := s.Repos(ctx)
	if err != nil {
		info.Error = "The registry service isn't answering. Make sure the \"registry\" service from docker-compose.yml is running."
		return info
	}
	info.Reachable = true
	info.Repos = len(repos)
	if n, err := s.diskUsage(ctx); err == nil {
		info.Size = n
	}
	return info
}

// Repos lists repositories with their tag counts.
func (s *Service) Repos(ctx context.Context) ([]model.RegistryRepo, error) {
	var cat struct {
		Repositories []string `json:"repositories"`
	}
	if _, err := s.get(ctx, "/v2/_catalog?n=1000", "", &cat); err != nil {
		return nil, err
	}
	out := make([]model.RegistryRepo, len(cat.Repositories))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, name := range cat.Repositories {
		out[i] = model.RegistryRepo{Name: name}
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var tl struct {
				Tags []string `json:"tags"`
			}
			if _, err := s.get(ctx, "/v2/"+name+"/tags/list", "", &tl); err == nil {
				out[i].Tags = len(tl.Tags)
				sort.Strings(tl.Tags)
				for _, t := range tl.Tags {
					out[i].Latest = t
					if t == "latest" {
						break
					}
				}
			}
		}(i, name)
	}
	wg.Wait()
	// Repositories whose tags were all deleted stay in the catalog until garbage collection; hide them.
	kept := out[:0]
	for _, r := range out {
		if r.Tags > 0 {
			kept = append(kept, r)
		}
	}
	return kept, nil
}

const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, " +
	"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

type manifest struct {
	MediaType string `json:"mediaType"`
	Manifests []struct {
		Digest   string `json:"digest"`
		Platform *struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
			Variant      string `json:"variant"`
		} `json:"platform"`
		Annotations map[string]string `json:"annotations"`
	} `json:"manifests"`
	Config struct {
		Digest string `json:"digest"`
		Size   int64  `json:"size"`
	} `json:"config"`
	Layers []struct {
		Size int64 `json:"size"`
	} `json:"layers"`
}

// Tags describes every tag of a repository, newest first.
func (s *Service) Tags(ctx context.Context, repo string) ([]model.RegistryTag, error) {
	if err := validRepo(repo); err != nil {
		return nil, err
	}
	var tl struct {
		Tags []string `json:"tags"`
	}
	if _, err := s.get(ctx, "/v2/"+repo+"/tags/list", "", &tl); err != nil {
		return nil, err
	}
	if len(tl.Tags) > 200 {
		tl.Tags = tl.Tags[:200]
	}
	out := make([]model.RegistryTag, len(tl.Tags))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i, tag := range tl.Tags {
		wg.Add(1)
		go func(i int, tag string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = s.describe(ctx, repo, tag)
		}(i, tag)
	}
	wg.Wait()
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].CreatedAt, out[j].CreatedAt
		if a == nil || b == nil {
			return a != nil
		}
		return a.After(*b)
	})
	return out, nil
}

func (s *Service) describe(ctx context.Context, repo, tag string) model.RegistryTag {
	t := model.RegistryTag{Tag: tag, Platforms: []string{}}
	var m manifest
	h, err := s.get(ctx, "/v2/"+repo+"/manifests/"+tag, manifestAccept, &m)
	if err != nil {
		return t
	}
	t.Digest = h.Get("Docker-Content-Digest")
	if len(m.Manifests) > 0 { // multi-platform index: describe the first real platform
		child := ""
		for _, c := range m.Manifests {
			if c.Platform == nil || c.Platform.OS == "unknown" || c.Annotations["vnd.docker.reference.type"] == "attestation-manifest" {
				continue
			}
			p := c.Platform.OS + "/" + c.Platform.Architecture
			if c.Platform.Variant != "" {
				p += "/" + c.Platform.Variant
			}
			t.Platforms = append(t.Platforms, p)
			if child == "" {
				child = c.Digest
			}
		}
		if child == "" {
			return t
		}
		m = manifest{}
		if _, err := s.get(ctx, "/v2/"+repo+"/manifests/"+child, manifestAccept, &m); err != nil {
			return t
		}
	}
	t.Size = m.Config.Size
	for _, l := range m.Layers {
		t.Size += l.Size
	}
	if m.Config.Digest != "" {
		var cfg struct {
			Created      *time.Time `json:"created"`
			OS           string     `json:"os"`
			Architecture string     `json:"architecture"`
		}
		if _, err := s.get(ctx, "/v2/"+repo+"/blobs/"+m.Config.Digest, "", &cfg); err == nil {
			t.CreatedAt = cfg.Created
			if len(t.Platforms) == 0 && cfg.OS != "" {
				t.Platforms = append(t.Platforms, cfg.OS+"/"+cfg.Architecture)
			}
		}
	}
	return t
}

// DeleteTag removes the image a tag points to (and so every tag sharing its digest).
func (s *Service) DeleteTag(ctx context.Context, repo, tag string) error {
	if err := validRepo(repo); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, s.upstream.String()+"/v2/"+repo+"/manifests/"+url.PathEscape(tag), nil)
	req.Header.Set("Accept", manifestAccept)
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return dockerops.ErrNotFound
	}
	digest := resp.Header.Get("Docker-Content-Digest")
	if digest == "" {
		return fmt.Errorf("registry didn't return a digest for %s:%s", repo, tag)
	}
	req, _ = http.NewRequestWithContext(ctx, http.MethodDelete, s.upstream.String()+"/v2/"+repo+"/manifests/"+digest, nil)
	resp, err = s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("registry refused the delete: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func validRepo(repo string) error {
	if repo == "" || strings.Contains(repo, "..") || strings.HasPrefix(repo, "/") || strings.ContainsAny(repo, " ?#") {
		return &dockerops.BadRequest{Msg: "invalid repository name"}
	}
	return nil
}

// ─── Maintenance (inside the registry container) ───────────────────────────

func (s *Service) container(ctx context.Context) (*client.Client, string, error) {
	cli, err := client.NewClientWithOpts(client.WithHost("unix://"+config.LocalDockerSocket), client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, "", err
	}
	list, err := cli.ContainerList(ctx, container.ListOptions{Filters: filters.NewArgs(filters.Arg("label", "dockhand.role=registry"))})
	if err != nil || len(list) == 0 {
		cli.Close()
		if err == nil {
			err = errors.New("the registry container isn't running")
		}
		return nil, "", err
	}
	return cli, list[0].ID, nil
}

func (s *Service) exec(ctx context.Context, cmd []string, out io.Writer) (int, error) {
	cli, id, err := s.container(ctx)
	if err != nil {
		return -1, err
	}
	defer cli.Close()
	ex, err := cli.ContainerExecCreate(ctx, id, container.ExecOptions{Cmd: cmd, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return -1, err
	}
	hj, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		return -1, err
	}
	defer hj.Close()
	if _, err := stdcopy.StdCopy(out, out, hj.Reader); err != nil {
		return -1, err
	}
	in, err := cli.ContainerExecInspect(ctx, ex.ID)
	if err != nil {
		return -1, err
	}
	return in.ExitCode, nil
}

func (s *Service) restart(ctx context.Context) error {
	cli, id, err := s.container(ctx)
	if err != nil {
		return err
	}
	defer cli.Close()
	timeout := 10
	if err := cli.ContainerRestart(ctx, id, container.StopOptions{Timeout: &timeout}); err != nil {
		return err
	}
	// Wait until it answers again.
	for i := 0; i < 30; i++ {
		if _, err := s.get(ctx, "/v2/", "", nil); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return errors.New("the registry didn't come back after restarting")
}

func (s *Service) diskUsage(ctx context.Context) (int64, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var buf bytes.Buffer
	code, err := s.exec(cctx, []string{"du", "-sk", "/var/lib/registry"}, &buf)
	if err != nil || code != 0 {
		return -1, fmt.Errorf("du: %v", err)
	}
	f := strings.Fields(buf.String())
	if len(f) == 0 {
		return -1, errors.New("du: no output")
	}
	kb, err := strconv.ParseInt(f[0], 10, 64)
	return kb * 1024, err
}

// GarbageCollect deletes blobs no tag references any more (job).
func (s *Service) GarbageCollect(ctx context.Context, actor string) (string, error) {
	return s.jobs.Start(jobs.Spec{Kind: "prune", Title: "Reclaim space in Dockhand's registry", Actor: actor,
		Plan: []string{"Measuring", "Deleting unreferenced layers", "Restarting the registry", "Measuring"}},
		func(ctx context.Context, j *jobs.Job) error {
			j.Step("Measuring", "/var/lib/registry")
			before, _ := s.diskUsage(ctx)
			j.Step("Deleting unreferenced layers", "registry garbage-collect --delete-untagged")
			w := &lineWriter{fn: func(l string) {
				if strings.Contains(l, "marking") || strings.Contains(l, "Deleting blob") || strings.Contains(l, "blob eligible") {
					j.Log("muted", l)
				} else {
					j.Log("info", l)
				}
			}}
			code, err := s.exec(ctx, []string{"sh", "-c", `c=/etc/distribution/config.yml; [ -f "$c" ] || c=/etc/docker/registry/config.yml; registry garbage-collect --delete-untagged "$c"`}, w)
			w.flush()
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("garbage-collect exited with status %d", code)
			}
			// The registry caches which blobs exist; restart it so a re-push of a
			// collected layer uploads it again instead of being told it "already exists".
			j.Step("Restarting the registry", "clears its layer cache")
			if err := s.restart(ctx); err != nil {
				return fmt.Errorf("restart registry: %w", err)
			}
			j.Step("Measuring", "")
			after, _ := s.diskUsage(ctx)
			if before > 0 && after >= 0 {
				j.Logf("ok", "freed %s (now %s)", human(before-after), human(after))
				j.Set("freed", before-after)
			}
			return nil
		})
}

type lineWriter struct {
	buf []byte
	fn  func(string)
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		if l := strings.TrimSpace(string(w.buf[:i])); l != "" {
			w.fn(l)
		}
		w.buf = w.buf[i+1:]
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	if l := strings.TrimSpace(string(w.buf)); l != "" {
		w.fn(l)
	}
	w.buf = nil
}

func human(n int64) string {
	if n < 0 {
		n = 0
	}
	f := float64(n)
	for _, u := range []string{"B", "KB", "MB", "GB"} {
		if f < 1024 {
			return fmt.Sprintf("%.1f %s", f, u)
		}
		f /= 1024
	}
	return fmt.Sprintf("%.1f TB", f)
}
