package api

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/dockerops"
	"dockhand/internal/model"
)

// Dockhand's built-in registry and saved credentials for other registries.

func (s *Server) registryInfo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	ok(w, s.Registry.Info(ctx))
}

func (s *Server) registryRepos(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	list, err := s.Registry.Repos(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	ok(w, list)
}

func (s *Server) registryTags(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 45*time.Second)
	defer cancel()
	list, err := s.Registry.Tags(ctx, strings.TrimSpace(r.URL.Query().Get("repo")))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) registryDeleteTag(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	repo, tag := strings.TrimSpace(r.URL.Query().Get("repo")), strings.TrimSpace(r.URL.Query().Get("tag"))
	if tag == "" {
		writeErr(w, http.StatusBadRequest, "tag is required")
		return
	}
	if err := s.Registry.DeleteTag(ctx, repo, tag); err != nil {
		fail(w, err)
		return
	}
	slog.Info("registry: deleted tag", "image", repo+":"+tag, "user", actor(r))
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) registryGC(w http.ResponseWriter, r *http.Request) {
	id, err := s.Registry.GarbageCollect(r.Context(), actor(r))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, model.JobRef{JobID: id})
}

func (s *Server) registryTokens(w http.ResponseWriter, r *http.Request) {
	list, err := s.Registry.Tokens(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) createRegistryToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
	}
	if !decode(w, r, &in) {
		return
	}
	t, err := s.Registry.CreateToken(r.Context(), in.Name, in.Scope)
	if err != nil {
		fail(w, err)
		return
	}
	slog.Info("registry: created token", "name", t.Name, "scope", t.Scope, "user", actor(r))
	ok(w, t)
}

func (s *Server) revokeRegistryToken(w http.ResponseWriter, r *http.Request) {
	if err := s.Registry.RevokeToken(r.Context(), chi.URLParam(r, "tid")); err != nil {
		fail(w, err)
		return
	}
	slog.Info("registry: revoked token", "id", chi.URLParam(r, "tid"), "user", actor(r))
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) registryCredentials(w http.ResponseWriter, r *http.Request) {
	list, err := s.Registry.Credentials(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) saveRegistryCredential(w http.ResponseWriter, r *http.Request) {
	var in model.RegistryCredentialInput
	if !decode(w, r, &in) {
		return
	}
	c, err := s.Registry.SaveCredential(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	slog.Info("registry: saved credentials", "server", c.Server, "user", actor(r))
	ok(w, c)
}

func (s *Server) deleteRegistryCredential(w http.ResponseWriter, r *http.Request) {
	if err := s.Registry.DeleteCredential(r.Context(), chi.URLParam(r, "cid")); err != nil {
		fail(w, err)
		return
	}
	slog.Info("registry: deleted credentials", "id", chi.URLParam(r, "cid"), "user", actor(r))
	ok(w, map[string]bool{"ok": true})
}

// testRegistryCredential checks a login: {server, username, password} or ?id= for a saved one.
func (s *Server) testRegistryCredential(w http.ResponseWriter, r *http.Request) {
	var in model.RegistryCredentialInput
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	if err := s.Registry.TestCredential(ctx, in, r.URL.Query().Get("id")); err != nil {
		if strings.Contains(err.Error(), "no rows") {
			fail(w, dockerops.ErrNotFound)
			return
		}
		ok(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	ok(w, map[string]any{"ok": true})
}
