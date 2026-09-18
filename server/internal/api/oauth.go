package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/mcptools"
	"dockhand/internal/model"
)

// registerOAuth mounts the OAuth endpoints MCP clients use to connect without
// a pasted API key (see mcptools/oauth.go). They live outside /api: clients
// call them directly, without a session or the CSRF header.
func (s *Server) registerOAuth(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(openCORS, noStore)
		r.Get("/.well-known/oauth-protected-resource", s.oauthResourceMeta)
		r.Get("/.well-known/oauth-protected-resource/mcp", s.oauthResourceMeta)
		r.Get("/.well-known/oauth-authorization-server", s.oauthServerMeta)
		r.Get("/.well-known/oauth-authorization-server/mcp", s.oauthServerMeta)
		r.Post("/oauth/register", s.oauthRegister)
		r.Post("/oauth/token", s.oauthToken)
		r.Options("/*", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	})
	r.Get("/oauth/authorize", s.oauthAuthorize)
}

// openCORS allows browser-based MCP clients to reach the (cookie-less) OAuth endpoints.
func openCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
		next.ServeHTTP(w, r)
	})
}

func oauthFail(w http.ResponseWriter, err error) {
	if oe, ok := mcptools.IsOAuthError(err); ok {
		status := http.StatusBadRequest
		if oe.Code == "invalid_client" {
			status = http.StatusUnauthorized
		}
		writeJSON(w, status, map[string]string{"error": oe.Code, "error_description": oe.Desc})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error", "error_description": err.Error()})
}

func (s *Server) oauthResourceMeta(w http.ResponseWriter, r *http.Request) {
	ok(w, s.MCP.ProtectedResourceMetadata(r))
}

func (s *Server) oauthServerMeta(w http.ResponseWriter, r *http.Request) {
	ok(w, s.MCP.AuthServerMetadata(r))
}

func (s *Server) oauthRegister(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, sec, err := s.MCP.RegisterClient(r.Context(), in.ClientName, in.RedirectURIs, in.AuthMethod)
	if err != nil {
		oauthFail(w, err)
		return
	}
	method := "none"
	if sec != "" {
		method = in.AuthMethod
	}
	out := map[string]any{
		"client_id":                  c.ID,
		"client_name":                c.Name,
		"redirect_uris":              c.RedirectURIs,
		"token_endpoint_auth_method": method,
		"grant_types":                []string{"authorization_code"},
		"response_types":             []string{"code"},
	}
	if sec != "" {
		out["client_secret"] = sec
		out["client_secret_expires_at"] = 0
	}
	writeJSON(w, http.StatusCreated, out)
}

// oauthAuthorize validates the request and hands it to the consent page,
// which signs the user in if needed.
func (s *Server) oauthAuthorize(w http.ResponseWriter, r *http.Request) {
	req, redirect, err := s.MCP.CheckAuthorize(r.Context(), r.URL.Query())
	if err != nil {
		oe, isOAuth := mcptools.IsOAuthError(err)
		if redirect && isOAuth {
			http.Redirect(w, r, mcptools.RedirectWith(req.RedirectURI, url.Values{"error": {oe.Code}, "error_description": {oe.Desc}, "state": {req.State}}), http.StatusFound)
			return
		}
		http.Redirect(w, r, "/connect?"+url.Values{"error": {err.Error()}}.Encode(), http.StatusFound)
		return
	}
	http.Redirect(w, r, "/connect?"+r.URL.RawQuery, http.StatusFound)
}

func (s *Server) oauthToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		oauthFail(w, &mcptools.OAuthError{Code: "invalid_request", Desc: "expected a form-encoded body"})
		return
	}
	f := r.PostForm
	if gt := f.Get("grant_type"); gt != "authorization_code" {
		oauthFail(w, &mcptools.OAuthError{Code: "unsupported_grant_type", Desc: "grant_type must be authorization_code"})
		return
	}
	id, sec := f.Get("client_id"), f.Get("client_secret")
	if u, p, basic := r.BasicAuth(); basic {
		id, _ = url.QueryUnescape(u)
		sec, _ = url.QueryUnescape(p)
	}
	tok, err := s.MCP.Exchange(r.Context(), id, sec, f.Get("code"), f.Get("redirect_uri"), f.Get("code_verifier"))
	if err != nil {
		oauthFail(w, err)
		return
	}
	ok(w, map[string]any{"access_token": tok, "token_type": "Bearer", "scope": "mcp"})
}

// ─── Consent page API (session-authenticated, under /api) ──────────────────

type oauthRequestInfo struct {
	ClientName   string `json:"clientName"`
	RedirectHost string `json:"redirectHost"`
	McpEnabled   bool   `json:"mcpEnabled"`
}

func (s *Server) oauthRequest(w http.ResponseWriter, r *http.Request) {
	req, _, err := s.MCP.CheckAuthorize(r.Context(), r.URL.Query())
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	host := req.RedirectURI
	if u, err := url.Parse(req.RedirectURI); err == nil {
		host = u.Host
	}
	ok(w, oauthRequestInfo{ClientName: req.Client.Name, RedirectHost: host, McpEnabled: s.MCP.Enabled()})
}

func (s *Server) oauthApprove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Query   string   `json:"query"` // the original /oauth/authorize query string
		Approve bool     `json:"approve"`
		Scope   string   `json:"scope"`
		HostIDs []string `json:"hostIds"`
	}
	if !decode(w, r, &in) {
		return
	}
	q, err := url.ParseQuery(strings.TrimPrefix(in.Query, "?"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid authorization request")
		return
	}
	req, _, err := s.MCP.CheckAuthorize(r.Context(), q)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !in.Approve {
		ok(w, map[string]string{"redirect": mcptools.RedirectWith(req.RedirectURI, url.Values{"error": {"access_denied"}, "state": {req.State}})})
		return
	}
	if !s.MCP.Enabled() {
		writeErr(w, http.StatusConflict, "Turn on the MCP server in Settings → MCP first.")
		return
	}
	if in.Scope != "full" {
		in.Scope = "read"
	}
	client := "other"
	if strings.Contains(strings.ToLower(req.Client.Name), "claude") {
		client = "claude"
	}
	code := s.MCP.IssueCode(req, model.ApiKeyInput{Name: req.Client.Name + " (OAuth, " + actor(r) + ")", Client: client, Scope: in.Scope, HostIDs: in.HostIDs})
	params := url.Values{"code": {code}, "iss": {s.MCP.BaseURL(r)}}
	if req.State != "" {
		params.Set("state", req.State)
	}
	ok(w, map[string]string{"redirect": mcptools.RedirectWith(req.RedirectURI, params)})
}
