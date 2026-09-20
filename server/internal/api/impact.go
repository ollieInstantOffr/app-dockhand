package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/model"
)

// Blast radius: what an action would take down, before it is taken.

func (s *Server) hostImpact(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	imp, err := s.Impact.Host(ctx, id, r.URL.Query().Get("action"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, imp)
}

func (s *Server) stackImpact(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	imp, err := s.Impact.Stack(ctx, id, chi.URLParam(r, "name"), r.URL.Query().Get("action"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, imp)
}

func (s *Server) containerImpact(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	imp, err := s.Impact.Container(ctx, id, chi.URLParam(r, "cid"), r.URL.Query().Get("action"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, imp)
}

// patchImpact predicts what installing updates would restart.
func (s *Server) patchImpact(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		Packages     []string `json:"packages"`
		SecurityOnly bool     `json:"securityOnly"`
	}
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	if q := strings.TrimSpace(r.URL.Query().Get("packages")); q != "" {
		in.Packages = strings.Split(q, ",")
	}
	if r.URL.Query().Get("securityOnly") == "1" {
		in.SecurityOnly = true
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	res, err := s.Machines.PatchImpact(ctx, id, in.Packages, in.SecurityOnly)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

var _ = model.Impact{}
