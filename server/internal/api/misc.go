package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/alerts"
	"dockhand/internal/gitdeploy"
	"dockhand/internal/model"
	"dockhand/internal/settings"
	"dockhand/internal/uptime"
)

// ─── GitHub ─────────────────────────────────────────────────────────────────

func (s *Server) gitAccounts(w http.ResponseWriter, r *http.Request) {
	list, err := s.Git.Accounts(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) createGitAccount(w http.ResponseWriter, r *http.Request) {
	var in model.GitAccountInput
	if !decode(w, r, &in) {
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	a, err := s.Git.CreateAccount(ctx, in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, a)
}

func (s *Server) patchGitAccount(w http.ResponseWriter, r *http.Request) {
	var in gitdeploy.AccountPatch
	if !decode(w, r, &in) {
		return
	}
	a, err := s.Git.UpdateAccount(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, a)
}

func (s *Server) deleteGitAccount(w http.ResponseWriter, r *http.Request) {
	if err := s.Git.DeleteAccount(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) syncGitAccount(w http.ResponseWriter, r *http.Request) {
	a, err := s.Git.Sync(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, a)
}

func (s *Server) oauthDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ServerURL string `json:"serverUrl"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	d, err := s.Git.StartDevice(ctx, in.ServerURL)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, d)
}

func (s *Server) oauthPoll(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceCode string `json:"deviceCode"`
		ServerURL  string `json:"serverUrl"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.DeviceCode == "" {
		writeErr(w, http.StatusBadRequest, "deviceCode is required")
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	res, err := s.Git.PollDevice(ctx, in.DeviceCode, in.ServerURL)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

func (s *Server) githubAppCallback(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.URL.Query().Get("installation_id"), 10, 64)
	if err != nil || id <= 0 {
		http.Redirect(w, r, "/settings/github?error=missing_installation", http.StatusFound)
		return
	}
	// The callback is public (GitHub redirects the browser here); only accept it from a signed-in user.
	if sessionFrom(r) == nil {
		http.Redirect(w, r, "/login?next="+strings.ReplaceAll(r.URL.RequestURI(), "&", "%26"), http.StatusFound)
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	if _, err := s.Git.AddInstallation(ctx, id); err != nil {
		http.Redirect(w, r, "/settings/github?error="+strings.ReplaceAll(err.Error(), " ", "+"), http.StatusFound)
		return
	}
	http.Redirect(w, r, "/settings/github", http.StatusFound)
}

func (s *Server) gitRepos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := s.Git.Repos(r.Context(), gitdeploy.RepoQuery{Q: q.Get("q"), ComposeOnly: truthy(q.Get("compose")), AccountID: q.Get("accountId")})
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) gitAccountRepos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := s.Git.Repos(r.Context(), gitdeploy.RepoQuery{AccountID: q.Get("accountId"), All: true})
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) gitBranches(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	list, err := s.Git.Branches(ctx, chi.URLParam(r, "owner"), chi.URLParam(r, "name"), r.URL.Query().Get("accountId"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) gitInspect(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	res, err := s.Git.Inspect(ctx, chi.URLParam(r, "owner"), chi.URLParam(r, "name"), q.Get("ref"), q.Get("file"), q.Get("accountId"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

func (s *Server) deployGit(w http.ResponseWriter, r *http.Request) {
	var in model.GitDeployInput
	if !decode(w, r, &in) {
		return
	}
	id, err := s.Git.Deploy(r.Context(), in, actor(r))
	jobRef(w, id, err)
}

func (s *Server) rotateSecret(w http.ResponseWriter, r *http.Request) {
	sec, err := s.Git.RotateSecret(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, map[string]string{"secret": sec})
}

func (s *Server) githubWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "cannot read body")
		return
	}
	res, err := s.Git.HandleWebhook(r.Context(), r.Header.Get("X-GitHub-Event"), r.Header.Get("X-Hub-Signature-256"), body)
	if errors.Is(err, gitdeploy.ErrBadSignature) {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

// ─── Uptime ─────────────────────────────────────────────────────────────────

func (s *Server) uptimeOverview(w http.ResponseWriter, r *http.Request) {
	o, err := s.Uptime.Overview(r.Context(), r.URL.Query().Get("window"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, o)
}

func (s *Server) createMonitor(w http.ResponseWriter, r *http.Request) {
	var in model.MonitorInput
	if !decode(w, r, &in) {
		return
	}
	v, err := s.Uptime.Create(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, v)
}

func (s *Server) patchMonitor(w http.ResponseWriter, r *http.Request) {
	var in uptime.Patch
	if !decode(w, r, &in) {
		return
	}
	v, err := s.Uptime.Update(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, v)
}

func (s *Server) deleteMonitor(w http.ResponseWriter, r *http.Request) {
	if err := s.Uptime.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) checkMonitor(w http.ResponseWriter, r *http.Request) {
	v, err := s.Uptime.CheckNow(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, v)
}

func (s *Server) publicStatus(w http.ResponseWriter, r *http.Request) {
	if !s.Settings.Get().Uptime.PublicStatus {
		writeErr(w, http.StatusNotFound, "the public status page is disabled")
		return
	}
	st, err := s.Uptime.Public(r.Context(), r.URL.Query().Get("window"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, st)
}

// ─── Alerts & notifications ─────────────────────────────────────────────────

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	list, err := s.Alerts.List(r.Context(), r.URL.Query().Get("filter"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) readAllAlerts(w http.ResponseWriter, r *http.Request) {
	if err := s.Alerts.MarkAllRead(r.Context()); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) readAlert(w http.ResponseWriter, r *http.Request) {
	if err := s.Alerts.MarkRead(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) snoozeAlert(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Minutes int `json:"minutes"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := s.Alerts.Snooze(r.Context(), chi.URLParam(r, "id"), in.Minutes); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	list, err := s.Alerts.Channels(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]model.NotificationChannel, 0, len(list))
	for _, c := range list {
		out = append(out, c.View())
	}
	ok(w, out)
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	var in alerts.ChannelInput
	if !decode(w, r, &in) {
		return
	}
	c, err := s.Alerts.CreateChannel(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, c.View())
}

func (s *Server) patchChannel(w http.ResponseWriter, r *http.Request) {
	var in alerts.ChannelInput
	if !decode(w, r, &in) {
		return
	}
	c, err := s.Alerts.UpdateChannel(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		if strings.HasSuffix(err.Error(), "not found") {
			fail(w, err)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, c.View())
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	if err := s.Alerts.DeleteChannel(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) testChannel(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	err := s.Alerts.TestChannel(ctx, chi.URLParam(r, "id"))
	res := map[string]any{"ok": err == nil, "error": ""}
	if err != nil {
		res["error"] = err.Error()
	}
	ok(w, res)
}

// ─── Settings ───────────────────────────────────────────────────────────────

type githubView struct {
	AutoDeploy      bool   `json:"autoDeploy"`
	WaitChecks      bool   `json:"waitChecks"`
	OnlyCompose     bool   `json:"onlyCompose"`
	WebhookURL      string `json:"webhookUrl"`
	WebhookSecret   string `json:"webhookSecret"`
	AppConfigured   bool   `json:"appConfigured"`
	OAuthConfigured bool   `json:"oauthConfigured"`
	AppInstallURL   string `json:"appInstallUrl"`
}

type settingsView struct {
	General       settings.General       `json:"general"`
	Uptime        settings.Uptime        `json:"uptime"`
	GitHub        githubView             `json:"github"`
	MCP           settings.MCP           `json:"mcp"`
	Updates       settings.Updates       `json:"updates"`
	Notifications settings.Notifications `json:"notifications"`
	Registry      settings.Registry      `json:"registry"`
}

func (s *Server) settingsView(st settings.Settings) settingsView {
	sec, _ := s.Git.WebhookSecret()
	masked := ""
	if sec != "" {
		masked = "••••••••"
		if len(sec) > 4 {
			masked += sec[len(sec)-4:]
		}
	}
	return settingsView{General: st.General, Uptime: st.Uptime, MCP: st.MCP, Updates: st.Updates, Notifications: st.Notifications, Registry: st.Registry,
		GitHub: githubView{AutoDeploy: st.GitHub.AutoDeploy, WaitChecks: st.GitHub.WaitChecks, OnlyCompose: st.GitHub.OnlyCompose,
			WebhookURL: strings.TrimRight(st.General.PublicURL, "/") + "/api/webhooks/github", WebhookSecret: masked,
			AppConfigured: s.Cfg.AppConfigured(), OAuthConfigured: s.Cfg.GitHubOAuthClientID != "", AppInstallURL: s.Git.AppInstallURL()}}
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	ok(w, s.settingsView(s.Settings.Get()))
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]map[string]any
	if !decode(w, r, &in) {
		return
	}
	st, err := s.Settings.Patch(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, s.settingsView(st))
}

// ─── MCP ────────────────────────────────────────────────────────────────────

func (s *Server) mcpStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.MCP.Status(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, st)
}

func (s *Server) mcpKeys(w http.ResponseWriter, r *http.Request) {
	list, err := s.MCP.Keys(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) createMcpKey(w http.ResponseWriter, r *http.Request) {
	var in model.ApiKeyInput
	if !decode(w, r, &in) {
		return
	}
	k, err := s.MCP.CreateKey(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, k)
}

func (s *Server) revokeMcpKey(w http.ResponseWriter, r *http.Request) {
	if err := s.MCP.RevokeKey(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) mcpActivity(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.MCP.Activity(r.Context(), limit)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

// ─── System ─────────────────────────────────────────────────────────────────

func (s *Server) systemInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.System.Info(r.Context(), false)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, info)
}

func (s *Server) systemCheck(w http.ResponseWriter, r *http.Request) {
	info, err := s.System.Info(r.Context(), true)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, info)
}

func (s *Server) systemHistory(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	h, err := s.System.History(r.Context(), page, limit)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, h)
}

func (s *Server) systemUpdater(w http.ResponseWriter, r *http.Request) {
	st, err := s.System.UpdaterStatus(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, st)
}

func (s *Server) systemUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := s.System.Update(r.Context(), actor(r))
	jobRef(w, id, err)
}

func (s *Server) systemRollback(w http.ResponseWriter, r *http.Request) {
	id, err := s.System.Rollback(r.Context(), actor(r))
	jobRef(w, id, err)
}
