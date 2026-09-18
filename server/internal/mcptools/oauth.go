package mcptools

// OAuth 2.1 authorization server for the MCP endpoint, so clients that can't
// send a static Bearer header (Claude chat, Cowork, and Claude Code without
// --header) can connect: they discover it from the 401 on /mcp, register via
// dynamic client registration, send the user through the consent page, and
// exchange the code (PKCE S256) for an access token. The access token is an
// ordinary Dockhand API key, so scoping, revocation and activity work as for
// keys created by hand.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/secret"
)

const codeTTL = 10 * time.Minute

// OAuthClient is an oauth_clients row.
type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	secretHash   string
}

// OAuthError is an error reported to the client as RFC 6749 JSON.
type OAuthError struct {
	Code, Desc string
}

func (e *OAuthError) Error() string { return e.Code + ": " + e.Desc }

func oerr(code, desc string) error { return &OAuthError{Code: code, Desc: desc} }

type authCode struct {
	clientID, redirectURI, challenge string
	key                              model.ApiKeyInput
	exp                              time.Time
}

type oauthState struct {
	mu    sync.Mutex
	codes map[string]authCode
}

// BaseURL is the public origin OAuth metadata is published under: the
// configured public URL when the request came in on that host, otherwise the
// origin the request was made to (honouring X-Forwarded-* from a proxy).
func (p *Provider) BaseURL(r *http.Request) string {
	pub := strings.TrimRight(p.settings.Get().General.PublicURL, "/")
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = strings.TrimSpace(strings.Split(h, ",")[0])
	}
	if u, err := url.Parse(pub); err == nil && u.Host != "" && strings.EqualFold(u.Host, host) {
		return pub
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if pr := r.Header.Get("X-Forwarded-Proto"); pr != "" {
		scheme = strings.TrimSpace(strings.Split(pr, ",")[0])
	}
	return scheme + "://" + host
}

// ResourceMetadataURL implements mcp.ResourceMetadata.
func (p *Provider) ResourceMetadataURL(r *http.Request) string {
	return p.BaseURL(r) + "/.well-known/oauth-protected-resource/mcp"
}

// ProtectedResourceMetadata is the RFC 9728 document for /mcp.
func (p *Provider) ProtectedResourceMetadata(r *http.Request) map[string]any {
	base := p.BaseURL(r)
	return map[string]any{
		"resource":                 base + "/mcp",
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"mcp"},
		"resource_name":            "Dockhand",
	}
}

// AuthServerMetadata is the RFC 8414 document.
func (p *Provider) AuthServerMetadata(r *http.Request) map[string]any {
	base := p.BaseURL(r)
	return map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post", "client_secret_basic"},
		"scopes_supported":                      []string{"mcp"},
	}
}

// validRedirect accepts https URLs and http loopback URLs (native clients).
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Fragment != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		if h == "localhost" {
			return true
		}
		ip := net.ParseIP(h)
		return ip != nil && ip.IsLoopback()
	}
	return false
}

// RegisterClient implements dynamic client registration (RFC 7591). A secret
// is issued only when the client asks for a secret-based auth method.
func (p *Provider) RegisterClient(ctx context.Context, name string, redirects []string, authMethod string) (OAuthClient, string, error) {
	if len(redirects) == 0 {
		return OAuthClient{}, "", oerr("invalid_redirect_uri", "redirect_uris is required")
	}
	for _, u := range redirects {
		if !validRedirect(u) {
			return OAuthClient{}, "", oerr("invalid_redirect_uri", "redirect URIs must be https, or http on localhost: "+u)
		}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "MCP client"
	}
	if len(name) > 100 {
		name = name[:100]
	}
	var sec, hash string
	switch authMethod {
	case "", "none":
	case "client_secret_post", "client_secret_basic":
		sec = secret.RandomBase62(40)
		hash = hashKey(sec)
	default:
		return OAuthClient{}, "", oerr("invalid_client_metadata", "unsupported token_endpoint_auth_method "+authMethod)
	}
	c := OAuthClient{Name: name, RedirectURIs: redirects, secretHash: hash}
	err := p.db.QueryRow(ctx, `INSERT INTO oauth_clients (name, redirect_uris, secret_hash) VALUES ($1, $2, $3) RETURNING id::text`,
		name, db.JSON(redirects), hash).Scan(&c.ID)
	return c, sec, err
}

// Client looks up a registered client.
func (p *Provider) Client(ctx context.Context, id string) (OAuthClient, error) {
	c := OAuthClient{ID: id}
	var redirects []byte
	err := p.db.QueryRow(ctx, `SELECT name, redirect_uris, secret_hash FROM oauth_clients WHERE id::text = $1`, id).
		Scan(&c.Name, &redirects, &c.secretHash)
	if db.IsNoRows(err) {
		return c, oerr("invalid_client", "unknown client_id; register the client again")
	}
	if err != nil {
		return c, err
	}
	_ = json.Unmarshal(redirects, &c.RedirectURIs)
	return c, nil
}

// AuthRequest is a validated /oauth/authorize request.
type AuthRequest struct {
	Client      OAuthClient
	RedirectURI string
	State       string
	Challenge   string
}

// CheckAuthorize validates authorize parameters. An error whose redirect is
// false must be shown to the user instead of being sent to redirect_uri.
func (p *Provider) CheckAuthorize(ctx context.Context, q url.Values) (req AuthRequest, redirect bool, err error) {
	c, err := p.Client(ctx, q.Get("client_id"))
	if err != nil {
		return req, false, err
	}
	ru := q.Get("redirect_uri")
	if ru == "" && len(c.RedirectURIs) == 1 {
		ru = c.RedirectURIs[0]
	}
	found := false
	for _, u := range c.RedirectURIs {
		found = found || u == ru
	}
	if !found {
		return req, false, oerr("invalid_request", "redirect_uri is not registered for this client")
	}
	req = AuthRequest{Client: c, RedirectURI: ru, State: q.Get("state"), Challenge: q.Get("code_challenge")}
	switch {
	case q.Get("response_type") != "code":
		return req, true, oerr("unsupported_response_type", "response_type must be code")
	case req.Challenge == "" || q.Get("code_challenge_method") != "S256":
		return req, true, oerr("invalid_request", "PKCE with code_challenge_method=S256 is required")
	}
	return req, true, nil
}

// IssueCode records an approved request and returns the authorization code.
// The API key itself is created when the code is redeemed.
func (p *Provider) IssueCode(req AuthRequest, key model.ApiKeyInput) string {
	code := secret.RandomBase62(40)
	p.oauth.mu.Lock()
	defer p.oauth.mu.Unlock()
	if p.oauth.codes == nil {
		p.oauth.codes = map[string]authCode{}
	}
	now := time.Now()
	for k, c := range p.oauth.codes {
		if now.After(c.exp) {
			delete(p.oauth.codes, k)
		}
	}
	p.oauth.codes[code] = authCode{clientID: req.Client.ID, redirectURI: req.RedirectURI, challenge: req.Challenge, key: key, exp: now.Add(codeTTL)}
	return code
}

// RedirectWith appends query parameters to a redirect URI.
func RedirectWith(redirectURI string, params url.Values) string {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return redirectURI
	}
	q := u.Query()
	for k, v := range params {
		q[k] = v
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// Exchange redeems an authorization code (single use) for an access token.
func (p *Provider) Exchange(ctx context.Context, clientID, clientSecret, code, redirectURI, verifier string) (string, error) {
	p.oauth.mu.Lock()
	ac, found := p.oauth.codes[code]
	delete(p.oauth.codes, code)
	p.oauth.mu.Unlock()
	if !found || time.Now().After(ac.exp) {
		return "", oerr("invalid_grant", "authorization code is invalid or expired")
	}
	if clientID != "" && clientID != ac.clientID {
		return "", oerr("invalid_grant", "code was issued to another client")
	}
	c, err := p.Client(ctx, ac.clientID)
	if err != nil {
		return "", err
	}
	if c.secretHash != "" && subtle.ConstantTimeCompare([]byte(hashKey(clientSecret)), []byte(c.secretHash)) != 1 {
		return "", oerr("invalid_client", "client authentication failed")
	}
	if redirectURI != "" && redirectURI != ac.redirectURI {
		return "", oerr("invalid_grant", "redirect_uri does not match the authorization request")
	}
	sum := sha256.Sum256([]byte(verifier))
	if verifier == "" || base64.RawURLEncoding.EncodeToString(sum[:]) != ac.challenge {
		return "", oerr("invalid_grant", "PKCE verification failed")
	}
	k, err := p.CreateKey(ctx, ac.key)
	if err != nil {
		return "", err
	}
	return k.Key, nil
}

// IsOAuthError reports whether err is an OAuthError.
func IsOAuthError(err error) (*OAuthError, bool) {
	var oe *OAuthError
	ok := errors.As(err, &oe)
	return oe, ok
}
