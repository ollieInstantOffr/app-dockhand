package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/model"
)

// Disk usage, deploy pre-flight checks and dry-runs (v2 deploy flow).

func (s *Server) hostDisk(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 12*time.Second)
	defer cancel()
	du, err := s.Ops.DiskUsage(ctx, chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, du)
}

func (s *Server) deployCheck(w http.ResponseWriter, r *http.Request) {
	var in model.DeployCheckInput
	if !decode(w, r, &in) {
		return
	}
	res, err := s.Preflight.Check(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

func (s *Server) deployGitDryRun(w http.ResponseWriter, r *http.Request) {
	var in model.GitDeployInput
	if !decode(w, r, &in) {
		return
	}
	res, err := s.Git.DryRun(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

func (s *Server) runContainerDryRun(w http.ResponseWriter, r *http.Request) {
	var in model.RunContainerInput
	if !decode(w, r, &in) {
		return
	}
	res, err := s.Ops.RunDryRun(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}
