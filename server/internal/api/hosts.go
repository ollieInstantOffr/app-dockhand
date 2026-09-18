package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/hosts"
	"dockhand/internal/model"
)

func (s *Server) hostView(r hosts.Record) model.Host { return s.Monitor.HostView(r) }

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := s.Hosts.List(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	o := model.Overview{Hosts: len(list), Attention: []model.AttentionItem{}}
	for _, rec := range list {
		v := s.hostView(rec)
		if v.Status == "online" || v.Status == "degraded" {
			o.Online++
		}
		o.Running += v.Running
		o.Total += v.Total
		o.Updates += v.Updates
	}
	o.UnreadAlerts, _ = s.Alerts.UnreadCount(ctx)
	probs, err := s.Alerts.OpenProblems(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	for _, a := range probs {
		text := a.Title
		if a.Text != "" && len(a.Text) < 140 {
			text = a.Title + " — " + a.Text
		}
		o.Attention = append(o.Attention, model.AttentionItem{Severity: a.Severity, HostID: a.HostID, Host: a.HostName,
			Text: text, Action: a.Action, Href: a.Href})
	}
	ok(w, o)
}

func (s *Server) allContainers(w http.ResponseWriter, r *http.Request) {
	list, err := s.Hosts.List(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	ids := make([]string, 0, len(list))
	for _, h := range list {
		ids = append(ids, h.ID)
	}
	ok(w, s.Monitor.AllContainers(ids))
}

func (s *Server) listHosts(w http.ResponseWriter, r *http.Request) {
	list, err := s.Hosts.List(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]model.Host, 0, len(list))
	for _, h := range list {
		out = append(out, s.hostView(h))
	}
	ok(w, out)
}

func (s *Server) getHost(w http.ResponseWriter, r *http.Request) {
	rec, err := s.Hosts.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, s.hostView(rec))
}

func (s *Server) createHost(w http.ResponseWriter, r *http.Request) {
	var in model.HostInput
	if !decode(w, r, &in) {
		return
	}
	rec, err := s.Hosts.Create(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.Uptime.EnsureHostMonitors(r.Context())
	go s.Monitor.PollHost(context.Background(), rec)
	ok(w, s.hostView(rec))
}

func (s *Server) patchHost(w http.ResponseWriter, r *http.Request) {
	var p hosts.Patch
	if !decode(w, r, &p) {
		return
	}
	rec, changed, err := s.Hosts.Update(r.Context(), chi.URLParam(r, "id"), p)
	if err != nil {
		if err == hosts.ErrNotFound {
			fail(w, err)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if changed {
		s.Conns.Invalidate(rec.ID)
		go s.Monitor.PollHost(context.Background(), rec)
	}
	s.Uptime.SyncHostMonitor(r.Context(), rec.ID, rec.Name, rec.Address)
	ok(w, s.hostView(rec))
}

func (s *Server) deleteHost(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rec, err := s.Hosts.Get(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.Hosts.Delete(r.Context(), rec.ID); err != nil {
		fail(w, err)
		return
	}
	s.Monitor.Forget(rec.ID)
	empty(w)
}

func (s *Server) testNewHost(w http.ResponseWriter, r *http.Request) {
	var in model.HostInput
	if !decode(w, r, &in) {
		return
	}
	if err := hosts.Validate(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	t := hosts.Target{Name: in.Name, Address: in.Address, Port: in.Port, User: in.User, Method: in.Method, Password: in.Password}
	out := s.Conns.Test(r.Context(), t)
	ok(w, out.Result)
}

func (s *Server) testHost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rec, err := s.Hosts.Get(ctx, chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	t, err := s.Conns.Target(rec)
	if err != nil {
		fail(w, err)
		return
	}
	out := s.Conns.Test(ctx, t)
	res := out.Result
	if res.OK {
		bgc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if rec.HostKey == "" && out.HostKey != "" {
			_ = s.Hosts.PinHostKey(bgc, rec.ID, out.HostKey)
		}
		f := out.Facts
		f.CPU = rec.CPU
		_ = s.Hosts.RecordSuccess(bgc, rec.ID, "online", f)
		s.Conns.Invalidate(rec.ID)
		if fresh, err := s.Hosts.Get(bgc, rec.ID); err == nil {
			v := s.hostView(fresh)
			res.Host = &v
			go s.Monitor.PollHost(context.Background(), fresh)
		}
	}
	ok(w, res)
}

func (s *Server) rebootHost(w http.ResponseWriter, r *http.Request) {
	if err := s.Ops.Reboot(r.Context(), chi.URLParam(r, "id")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) pruneHost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Containers, Images, Networks, Volumes, BuildCache bool
	}
	if !decode(w, r, &in) {
		return
	}
	id, err := s.Ops.PruneHost(r.Context(), chi.URLParam(r, "id"), pruneInput(in.Containers, in.Images, in.Networks, in.Volumes, in.BuildCache), actor(r))
	jobRef(w, id, err)
}

func (s *Server) updateAll(w http.ResponseWriter, r *http.Request) {
	id, err := s.Ops.UpdateAll(r.Context(), chi.URLParam(r, "id"), actor(r))
	jobRef(w, id, err)
}

// parseRange accepts Go durations plus "Nd".
func parseRange(v string, def time.Duration) time.Duration {
	if v == "" {
		return def
	}
	if strings.HasSuffix(v, "d") {
		if n, err := strconv.Atoi(strings.TrimSuffix(v, "d")); err == nil && n > 0 {
			return time.Duration(n) * 24 * time.Hour
		}
	}
	if d, err := time.ParseDuration(v); err == nil && d > 0 {
		return d
	}
	return def
}

func (s *Server) hostMetrics(w http.ResponseWriter, r *http.Request) {
	rng := parseRange(r.URL.Query().Get("range"), time.Hour)
	if rng > 48*time.Hour {
		rng = 48 * time.Hour
	}
	rec, err := s.Hosts.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	pts, err := s.Hosts.Metrics(r.Context(), rec.ID, rng)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, pts)
}

func jobRef(w http.ResponseWriter, id string, err error) {
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, model.JobRef{JobID: id})
}

// hostID resolves the {id} param to a host id (404 if unknown).
func (s *Server) hostID(w http.ResponseWriter, r *http.Request) (string, bool) {
	rec, err := s.Hosts.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return "", false
	}
	return rec.ID, true
}
