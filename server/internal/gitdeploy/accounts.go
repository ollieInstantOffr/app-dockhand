// Package gitdeploy connects GitHub accounts, syncs their repositories and
// deploys Compose projects from them (including push-webhook redeploys).
package gitdeploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/github"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
	"dockhand/internal/stacks"
	"dockhand/internal/util"
)

var ErrAccountNotFound = errors.New("GitHub account not found")

type Service struct {
	cfg      *config.Config
	db       *db.DB
	box      *secret.Box
	settings *settings.Store
	hosts    *hosts.Store
	conns    *hosts.Manager
	mon      *monitor.Monitor
	jobs     *jobs.Runner
	stacks   *stacks.Service
	root     context.Context

	mu       sync.Mutex
	syncing  map[string]bool
	appToken map[int64]cachedToken
}

type cachedToken struct {
	token   string
	expires time.Time
}

func New(root context.Context, cfg *config.Config, pool *db.DB, box *secret.Box, st *settings.Store, hs *hosts.Store,
	conns *hosts.Manager, mon *monitor.Monitor, jr *jobs.Runner, sk *stacks.Service) *Service {
	s := &Service{cfg: cfg, db: pool, box: box, settings: st, hosts: hs, conns: conns, mon: mon, jobs: jr, stacks: sk, root: root,
		syncing: map[string]bool{}, appToken: map[int64]cachedToken{}}
	sk.GitRedeploy = s.redeploy
	return s
}

// Account is a git_accounts row.
type Account struct {
	model.GitAccount
	APIURL         string
	TokenEnc       string
	InstallationID *int64
}

const acctCols = `a.id::text, a.login, a.kind, a.method, a.server_url, a.api_url, a.token_enc, a.installation_id, a.enabled, a.repo_access,
	a.selected_repos, a.webhook, a.color, a.last_sync_at, a.last_error,
	(SELECT count(*) FROM git_repos r WHERE r.account_id = a.id),
	(SELECT count(*) FROM git_repos r WHERE r.account_id = a.id AND jsonb_array_length(r.compose_files) > 0)`

func (s *Service) scanAccount(row interface{ Scan(...any) error }) (Account, error) {
	var a Account
	var sel []byte
	g := &a.GitAccount
	err := row.Scan(&g.ID, &g.Login, &g.Kind, &g.Method, &g.ServerURL, &a.APIURL, &a.TokenEnc, &a.InstallationID, &g.Enabled,
		&g.RepoAccess, &sel, &g.Webhook, &g.Color, &g.LastSyncAt, &g.LastError, &g.RepoCount, &g.ComposeRepoCount)
	if err != nil {
		return a, err
	}
	_ = json.Unmarshal(sel, &g.SelectedRepos)
	g.SelectedRepos = util.NZ(g.SelectedRepos)
	s.mu.Lock()
	syncing := s.syncing[g.ID]
	s.mu.Unlock()
	switch {
	case syncing:
		g.Status = "syncing"
	case g.LastError != "":
		g.Status = "error"
	default:
		g.Status = "ok"
	}
	return a, nil
}

// Accounts lists connected accounts.
func (s *Service) Accounts(ctx context.Context) ([]model.GitAccount, error) {
	rows, err := s.db.Query(ctx, `SELECT `+acctCols+` FROM git_accounts a ORDER BY a.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.GitAccount{}
	for rows.Next() {
		a, err := s.scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a.GitAccount)
	}
	return out, rows.Err()
}

// Account loads one account.
func (s *Service) Account(ctx context.Context, id string) (Account, error) {
	a, err := s.scanAccount(s.db.QueryRow(ctx, `SELECT `+acctCols+` FROM git_accounts a WHERE a.id::text = $1`, id))
	if db.IsNoRows(err) {
		return a, ErrAccountNotFound
	}
	return a, err
}

func apiURLFor(serverURL string) string {
	u := strings.TrimRight(strings.TrimSpace(serverURL), "/")
	if u == "" || u == "https://github.com" || u == "http://github.com" {
		return "https://api.github.com"
	}
	return u + "/api/v3"
}

func normServer(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if u == "" {
		return "https://github.com"
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "https://" + u
	}
	return u
}

// token returns a usable API token for the account.
func (s *Service) token(ctx context.Context, a Account) (string, error) {
	if a.Method == "app" {
		if a.InstallationID == nil {
			return "", errors.New("GitHub App account has no installation id")
		}
		if !s.cfg.AppConfigured() {
			return "", errors.New("GitHub App credentials are not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)")
		}
		s.mu.Lock()
		c, ok := s.appToken[*a.InstallationID]
		s.mu.Unlock()
		if ok && time.Until(c.expires) > 5*time.Minute {
			return c.token, nil
		}
		tok, exp, err := github.AppInstallationToken(ctx, a.APIURL, s.cfg.GitHubAppID, s.cfg.GitHubAppKey, *a.InstallationID)
		if err != nil {
			return "", err
		}
		s.mu.Lock()
		s.appToken[*a.InstallationID] = cachedToken{tok, exp}
		s.mu.Unlock()
		return tok, nil
	}
	return s.box.Decrypt(a.TokenEnc)
}

// Client returns an API client for the account.
func (s *Service) Client(ctx context.Context, a Account) (*github.Client, error) {
	tok, err := s.token(ctx, a)
	if err != nil {
		return nil, err
	}
	return github.New(a.APIURL, tok), nil
}

var palette = []string{"#7a5cf0", "#2f6fed", "#12a594", "#e5484d", "#f76b15", "#d6409f", "#0090ff", "#46a758"}

// CreateAccount validates credentials and stores a new account, then syncs repos in the background.
func (s *Service) CreateAccount(ctx context.Context, in model.GitAccountInput) (model.GitAccount, error) {
	server := normServer(in.ServerURL)
	apiURL := apiURLFor(server)
	kind := in.Kind
	switch in.Method {
	case "pat", "oauth":
		tok := strings.TrimSpace(in.Token)
		if in.Method == "oauth" && tok == "" {
			if in.DeviceCode == "" {
				return model.GitAccount{}, &dockerops.BadRequest{Msg: "deviceCode is required for OAuth"}
			}
			if s.cfg.GitHubOAuthClientID == "" {
				return model.GitAccount{}, &dockerops.BadRequest{Msg: "GITHUB_OAUTH_CLIENT_ID is not configured"}
			}
			t, status, err := github.PollDeviceFlow(ctx, server, s.cfg.GitHubOAuthClientID, in.DeviceCode)
			if err != nil {
				return model.GitAccount{}, err
			}
			if status != "ok" {
				return model.GitAccount{}, &dockerops.BadRequest{Msg: "GitHub authorization is " + status}
			}
			tok = t
		}
		if tok == "" {
			return model.GitAccount{}, &dockerops.BadRequest{Msg: "a token is required"}
		}
		login, vkind, err := github.New(apiURL, tok).Viewer(ctx)
		if err != nil {
			return model.GitAccount{}, &dockerops.BadRequest{Msg: "GitHub rejected the token: " + err.Error()}
		}
		if kind == "" || kind == "user" {
			kind = vkind
		}
		if server != "https://github.com" && kind != "org" {
			kind = "enterprise"
		}
		enc, err := s.box.Encrypt(tok)
		if err != nil {
			return model.GitAccount{}, err
		}
		return s.insertAccount(ctx, login, kind, in.Method, server, apiURL, enc, nil)
	case "app":
		if in.InstallationID == 0 {
			return model.GitAccount{}, &dockerops.BadRequest{Msg: "installationId is required"}
		}
		return s.AddInstallation(ctx, in.InstallationID)
	}
	return model.GitAccount{}, &dockerops.BadRequest{Msg: "method must be pat, oauth or app"}
}

func (s *Service) insertAccount(ctx context.Context, login, kind, method, server, apiURL, tokenEnc string, installID *int64) (model.GitAccount, error) {
	if kind == "" {
		kind = "user"
	}
	var n int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM git_accounts`).Scan(&n)
	color := palette[n%len(palette)]
	var id string
	// Re-connecting the same login replaces its credentials.
	err := s.db.QueryRow(ctx, `SELECT id::text FROM git_accounts WHERE lower(login) = lower($1) AND server_url = $2 AND method = $3`,
		login, server, method).Scan(&id)
	if err == nil {
		_, err = s.db.Exec(ctx, `UPDATE git_accounts SET token_enc=$2, installation_id=$3, kind=$4, api_url=$5, last_error='', enabled=true WHERE id::text=$1`,
			id, tokenEnc, installID, kind, apiURL)
	} else if db.IsNoRows(err) {
		err = s.db.QueryRow(ctx, `INSERT INTO git_accounts (login, kind, method, server_url, api_url, token_enc, installation_id, color)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`, login, kind, method, server, apiURL, tokenEnc, installID, color).Scan(&id)
	}
	if err != nil {
		return model.GitAccount{}, err
	}
	s.SyncAsync(id)
	a, err := s.Account(ctx, id)
	return a.GitAccount, err
}

// AddInstallation stores a GitHub App installation as an account.
func (s *Service) AddInstallation(ctx context.Context, installationID int64) (model.GitAccount, error) {
	if !s.cfg.AppConfigured() {
		return model.GitAccount{}, &dockerops.BadRequest{Msg: "GitHub App credentials are not configured"}
	}
	apiURL := "https://api.github.com"
	tok, exp, err := github.AppInstallationToken(ctx, apiURL, s.cfg.GitHubAppID, s.cfg.GitHubAppKey, installationID)
	if err != nil {
		return model.GitAccount{}, err
	}
	s.mu.Lock()
	s.appToken[installationID] = cachedToken{tok, exp}
	s.mu.Unlock()
	cl := github.New(apiURL, tok)
	login, kind := "", "user"
	if repos, err := cl.InstallationRepos(ctx); err == nil && len(repos) > 0 {
		login = repos[0].Owner
	}
	if login == "" {
		login = fmt.Sprintf("installation-%d", installationID)
	}
	var existing string
	err = s.db.QueryRow(ctx, `SELECT id::text FROM git_accounts WHERE installation_id = $1`, installationID).Scan(&existing)
	if err == nil {
		s.SyncAsync(existing)
		a, err := s.Account(ctx, existing)
		return a.GitAccount, err
	}
	return s.insertAccount(ctx, login, kind, "app", "https://github.com", apiURL, "", &installationID)
}

// AccountPatch is the PATCH body.
type AccountPatch struct {
	Enabled       *bool     `json:"enabled"`
	RepoAccess    *string   `json:"repoAccess"`
	SelectedRepos *[]string `json:"selectedRepos"`
	Webhook       *bool     `json:"webhook"`
}

// UpdateAccount applies a patch.
func (s *Service) UpdateAccount(ctx context.Context, id string, p AccountPatch) (model.GitAccount, error) {
	a, err := s.Account(ctx, id)
	if err != nil {
		return model.GitAccount{}, err
	}
	g := a.GitAccount
	if p.Enabled != nil {
		g.Enabled = *p.Enabled
	}
	if p.RepoAccess != nil {
		if *p.RepoAccess != "all" && *p.RepoAccess != "selected" {
			return g, &dockerops.BadRequest{Msg: "repoAccess must be all or selected"}
		}
		g.RepoAccess = *p.RepoAccess
	}
	if p.SelectedRepos != nil {
		g.SelectedRepos = util.NZ(*p.SelectedRepos)
	}
	if p.Webhook != nil {
		g.Webhook = *p.Webhook
	}
	_, err = s.db.Exec(ctx, `UPDATE git_accounts SET enabled=$2, repo_access=$3, selected_repos=$4, webhook=$5 WHERE id::text=$1`,
		id, g.Enabled, g.RepoAccess, db.JSON(g.SelectedRepos), g.Webhook)
	if err != nil {
		return g, err
	}
	a, err = s.Account(ctx, id)
	return a.GitAccount, err
}

// DeleteAccount removes an account (its repos cascade).
func (s *Service) DeleteAccount(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM git_accounts WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccountNotFound
	}
	return nil
}

// SyncAsync starts a background repo sync.
func (s *Service) SyncAsync(id string) {
	s.mu.Lock()
	if s.syncing[id] {
		s.mu.Unlock()
		return
	}
	s.syncing[id] = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.syncing, id)
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(s.root, 15*time.Minute)
		defer cancel()
		err := s.sync(ctx, id)
		msg := ""
		if err != nil {
			msg = err.Error()
			slog.Warn("github sync failed", "account", id, "err", err)
		}
		_, _ = s.db.Exec(context.Background(), `UPDATE git_accounts SET last_sync_at = now(), last_error = $2 WHERE id::text = $1`, id, msg)
	}()
}

func (s *Service) sync(ctx context.Context, id string) error {
	a, err := s.Account(ctx, id)
	if err != nil {
		return err
	}
	cl, err := s.Client(ctx, a)
	if err != nil {
		return err
	}
	var repos []github.Repo
	switch {
	case a.Method == "app":
		repos, err = cl.InstallationRepos(ctx)
	case a.Kind == "org":
		repos, err = cl.ListRepos(ctx, a.Login, true)
	default:
		repos, err = cl.ListRepos(ctx, "", false)
	}
	if err != nil {
		return err
	}
	// Existing pushed_at/compose_files to skip unchanged repos.
	type prev struct {
		pushed  *time.Time
		compose []string
	}
	known := map[int64]prev{}
	rows, err := s.db.Query(ctx, `SELECT id, pushed_at, compose_files FROM git_repos WHERE account_id::text = $1`, id)
	if err != nil {
		return err
	}
	for rows.Next() {
		var rid int64
		var p prev
		var cf []byte
		if rows.Scan(&rid, &p.pushed, &cf) == nil {
			_ = json.Unmarshal(cf, &p.compose)
			known[rid] = p
		}
	}
	rows.Close()

	compose := make([][]string, len(repos))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, r := range repos {
		if p, ok := known[r.ID]; ok && p.pushed != nil && !r.PushedAt.IsZero() && p.pushed.Equal(r.PushedAt) {
			compose[i] = p.compose
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, r github.Repo) {
			defer func() { <-sem; wg.Done() }()
			cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			files, err := cl.FindComposeFiles(cctx, r.Owner, r.Name, r.DefaultBranch)
			if err != nil {
				slog.Debug("find compose files", "repo", r.FullName, "err", err)
			}
			compose[i] = files
		}(i, r)
	}
	wg.Wait()

	ids := make([]int64, 0, len(repos))
	for i, r := range repos {
		ids = append(ids, r.ID)
		_, err := s.db.Exec(ctx, `INSERT INTO git_repos (id, account_id, owner, name, private, description, default_branch, compose_files, pushed_at, synced_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
			ON CONFLICT (id) DO UPDATE SET account_id=EXCLUDED.account_id, owner=EXCLUDED.owner, name=EXCLUDED.name, private=EXCLUDED.private,
			description=EXCLUDED.description, default_branch=EXCLUDED.default_branch, compose_files=EXCLUDED.compose_files,
			pushed_at=EXCLUDED.pushed_at, synced_at=now()`,
			r.ID, id, r.Owner, r.Name, r.Private, r.Description, r.DefaultBranch, db.JSON(util.NZ(compose[i])), util.TimePtr(r.PushedAt))
		if err != nil {
			return err
		}
	}
	_, err = s.db.Exec(ctx, `DELETE FROM git_repos WHERE account_id::text = $1 AND NOT (id = ANY($2))`, id, ids)
	return err
}

// SyncLoop re-syncs enabled accounts every 30 minutes.
func (s *Service) SyncLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rows, err := s.db.Query(ctx, `SELECT id::text FROM git_accounts WHERE enabled`)
			if err != nil {
				continue
			}
			var ids []string
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
			for _, id := range ids {
				s.SyncAsync(id)
			}
		}
	}
}

// Sync runs a synchronous sync (POST …/sync) with a bounded wait, then returns the account.
func (s *Service) Sync(ctx context.Context, id string) (model.GitAccount, error) {
	if _, err := s.Account(ctx, id); err != nil {
		return model.GitAccount{}, err
	}
	s.SyncAsync(id)
	a, err := s.Account(ctx, id)
	return a.GitAccount, err
}

// ─── Device flow ────────────────────────────────────────────────────────────

// StartDevice begins the OAuth device flow.
func (s *Service) StartDevice(ctx context.Context, serverURL string) (model.DeviceFlowStart, error) {
	if s.cfg.GitHubOAuthClientID == "" {
		return model.DeviceFlowStart{}, &dockerops.BadRequest{Msg: "GitHub OAuth is not configured (set GITHUB_OAUTH_CLIENT_ID)"}
	}
	dc, err := github.StartDeviceFlow(ctx, normServer(serverURL), s.cfg.GitHubOAuthClientID)
	if err != nil {
		return model.DeviceFlowStart{}, err
	}
	return model.DeviceFlowStart{DeviceCode: dc.DeviceCode, UserCode: dc.UserCode, VerificationURI: dc.VerificationURI,
		Interval: dc.Interval, ExpiresIn: dc.ExpiresIn}, nil
}

// PollResult is the device-flow poll response.
type PollResult struct {
	Status  string            `json:"status"`
	Account *model.GitAccount `json:"account,omitempty"`
}

// PollDevice polls once; on success it creates the account.
func (s *Service) PollDevice(ctx context.Context, deviceCode, serverURL string) (PollResult, error) {
	if s.cfg.GitHubOAuthClientID == "" {
		return PollResult{}, &dockerops.BadRequest{Msg: "GitHub OAuth is not configured"}
	}
	server := normServer(serverURL)
	tok, status, err := github.PollDeviceFlow(ctx, server, s.cfg.GitHubOAuthClientID, deviceCode)
	if err != nil {
		return PollResult{}, err
	}
	if status != "ok" {
		return PollResult{Status: status}, nil
	}
	acc, err := s.CreateAccount(ctx, model.GitAccountInput{Method: "oauth", Token: tok, ServerURL: server})
	if err != nil {
		return PollResult{}, err
	}
	return PollResult{Status: "ok", Account: &acc}, nil
}

// AppInstallURL returns the GitHub App installation URL.
func (s *Service) AppInstallURL() string {
	if s.cfg.GitHubAppSlug == "" {
		return ""
	}
	return "https://github.com/apps/" + s.cfg.GitHubAppSlug + "/installations/new"
}
