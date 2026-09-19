package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/machines"
	"dockhand/internal/model"
)

// Machines: the hosts themselves — OS updates, services, ports, hardening.

func (s *Server) listMachines(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	list, err := s.Machines.List(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) getMachine(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 100*time.Second)
	defer cancel()
	m, err := s.Machines.Get(ctx, id, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, m)
}

func (s *Server) refreshMachine(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 100*time.Second)
	defer cancel()
	m, err := s.Machines.Collect(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, m)
}

// machineAptUpdate refreshes the package lists on one machine.
func (s *Server) machineAptUpdate(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	jid, err := s.Machines.AptUpdate(r.Context(), id, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) machineInstall(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		Packages     []string `json:"packages"`
		SecurityOnly bool     `json:"securityOnly"`
	}
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Machines.Install(r.Context(), id, in.Packages, in.SecurityOnly, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) machineFix(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	jid, err := s.Machines.Fix(r.Context(), id, chi.URLParam(r, "check"), actor(r))
	jobRef(w, jid, err)
}

func (s *Server) machineService(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		Unit   string `json:"unit"`
		Action string `json:"action"`
	}
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Machines.ServiceAction(r.Context(), id, strings.TrimSpace(in.Unit), in.Action, actor(r))
	jobRef(w, jid, err)
}

// machinesFleet runs an audit or a patch run across every reachable machine.
func (s *Server) machinesFleet(w http.ResponseWriter, r *http.Request) {
	jid, err := s.Machines.FleetAction(r.Context(), chi.URLParam(r, "action"), actor(r))
	jobRef(w, jid, err)
}

// ─── Baselines ──────────────────────────────────────────────────────────────

func (s *Server) listBaselines(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	list, err := s.Machines.Baselines(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, map[string]any{"baselines": list, "rules": machines.RuleTitles})
}

func (s *Server) createBaseline(w http.ResponseWriter, r *http.Request) {
	var in model.BaselineInput
	if !decode(w, r, &in) {
		return
	}
	b, err := s.Machines.CreateBaseline(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, b)
}

func (s *Server) updateBaseline(w http.ResponseWriter, r *http.Request) {
	var in model.BaselineInput
	if !decode(w, r, &in) {
		return
	}
	b, err := s.Machines.UpdateBaseline(r.Context(), chi.URLParam(r, "bid"), in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, b)
}

func (s *Server) deleteBaseline(w http.ResponseWriter, r *http.Request) {
	if err := s.Machines.DeleteBaseline(r.Context(), chi.URLParam(r, "bid")); err != nil {
		fail(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}

func (s *Server) applyBaseline(w http.ResponseWriter, r *http.Request) {
	jid, err := s.Machines.ApplyBaseline(r.Context(), chi.URLParam(r, "bid"), actor(r))
	jobRef(w, jid, err)
}
