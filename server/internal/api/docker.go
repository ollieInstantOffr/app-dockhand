package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/dockerops"
	"dockhand/internal/model"
	"dockhand/internal/stacks"
)

func pruneInput(c, i, n, v, b bool) dockerops.PruneInput {
	return dockerops.PruneInput{Containers: c, Images: i, Networks: n, Volumes: v, BuildCache: b}
}

// ─── Containers ─────────────────────────────────────────────────────────────

func (s *Server) listContainers(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	list, err := s.Ops.Containers(ctx, id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) containerDetail(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	d, err := s.Ops.Detail(ctx, id, chi.URLParam(r, "cid"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, d)
}

func (s *Server) containerAction(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	action := chi.URLParam(r, "action")
	if action == "update" {
		jid, err := s.Ops.UpdateContainer(id, chi.URLParam(r, "cid"), actor(r))
		jobRef(w, jid, err)
		return
	}
	if !dockerops.ContainerActions[action] {
		writeErr(w, http.StatusNotFound, "unknown container action "+action)
		return
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	c, err := s.Ops.Action(ctx, id, chi.URLParam(r, "cid"), action, actor(r))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, c)
}

func (s *Server) bulkContainers(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		IDs    []string `json:"ids"`
		Action string   `json:"action"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !dockerops.ContainerActions[in.Action] && in.Action != "remove" && in.Action != "delete" && in.Action != "update" {
		writeErr(w, http.StatusBadRequest, "unknown action "+in.Action)
		return
	}
	ok(w, s.Ops.Bulk(r.Context(), id, in.IDs, in.Action, actor(r)))
}

func (s *Server) patchContainer(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in dockerops.PatchInput
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Ops.Patch(r.Context(), id, chi.URLParam(r, "cid"), in, actor(r))
	jobRef(w, jid, err)
}

func truthy(v string) bool { return v == "1" || v == "true" || v == "yes" }

func (s *Server) deleteContainer(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	q := r.URL.Query()
	if err := s.Ops.Remove(r.Context(), id, chi.URLParam(r, "cid"), truthy(q.Get("force")), truthy(q.Get("volumes")), actor(r)); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) runContainer(w http.ResponseWriter, r *http.Request) {
	var in model.RunContainerInput
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Ops.Run(r.Context(), in, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) containerLogs(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	q := r.URL.Query()
	tail := q.Get("tail")
	if tail == "" {
		tail = "500"
	}
	cid := chi.URLParam(r, "cid")
	ctx, cancel := reqCtx(r, 2*time.Minute)
	defer cancel()
	var b strings.Builder
	err := s.Ops.Logs(ctx, id, cid, dockerops.LogOpts{Tail: tail, Since: q.Get("since")}, func(l dockerops.LogLine) error {
		b.WriteString(l.T.UTC().Format(time.RFC3339Nano))
		b.WriteString(" ")
		if l.Stream == "stderr" {
			b.WriteString("[stderr] ")
		}
		b.WriteString(l.Line)
		b.WriteString("\n")
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if truthy(q.Get("download")) {
		name := strings.Map(func(r rune) rune {
			if r == '/' || r == '"' || r == '\\' || r < 32 {
				return '_'
			}
			return r
		}, cid)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.log"`, name, time.Now().UTC().Format("20060102-150405")))
	}
	_, _ = w.Write([]byte(b.String()))
}

// ─── Stacks ─────────────────────────────────────────────────────────────────

func (s *Server) listStacks(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	list, err := s.Stacks.List(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) createStack(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct{ Name, Content string }
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Stacks.Create(r.Context(), id, in.Name, in.Content, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) getCompose(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	f, err := s.Stacks.GetCompose(ctx, id, chi.URLParam(r, "name"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, f)
}

func (s *Server) putCompose(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct{ Content string }
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Stacks.PutCompose(r.Context(), id, chi.URLParam(r, "name"), in.Content, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) stackAction(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	jid, err := s.Stacks.Action(r.Context(), id, chi.URLParam(r, "name"), chi.URLParam(r, "action"), actor(r))
	jobRef(w, jid, err)
}

func (s *Server) patchStack(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		AutoDeploy *bool `json:"autoDeploy"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.AutoDeploy == nil {
		writeErr(w, http.StatusBadRequest, "autoDeploy is required")
		return
	}
	st, err := s.Stacks.SetAutoDeploy(r.Context(), id, chi.URLParam(r, "name"), *in.AutoDeploy)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, st)
}

func (s *Server) validateCompose(w http.ResponseWriter, r *http.Request) {
	var in struct{ Content string }
	if !decode(w, r, &in) {
		return
	}
	ok(w, stacks.Validate(in.Content))
}

func (s *Server) composeTemplates(w http.ResponseWriter, r *http.Request) { ok(w, stacks.Templates) }

// ─── Images ─────────────────────────────────────────────────────────────────

func (s *Server) listImages(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	list, err := s.Ops.Images(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) deleteImage(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	if err := s.Ops.RemoveImage(r.Context(), id, chi.URLParam(r, "iid"), truthy(r.URL.Query().Get("force"))); err != nil {
		fail(w, err)
		return
	}
	go s.Monitor.Refresh(bg(), id)
	empty(w)
}

func (s *Server) pruneImages(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	res, err := s.Ops.PruneImages(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, res)
}

func (s *Server) pullImage(w http.ResponseWriter, r *http.Request) {
	var in dockerops.PullInput
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Ops.PullJob(r.Context(), in, actor(r))
	jobRef(w, jid, err)
}

func (s *Server) imageTags(w http.ResponseWriter, r *http.Request) {
	img := strings.TrimSpace(r.URL.Query().Get("image"))
	if img == "" {
		writeErr(w, http.StatusBadRequest, "image is required")
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	ok(w, dockerops.Tags(ctx, img))
}

func (s *Server) imageSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		ok(w, []dockerops.SearchResult{})
		return
	}
	ctx, cancel := reqCtx(r, 10*time.Second)
	defer cancel()
	// Images in Dockhand's own registry come first.
	out := []dockerops.SearchResult{}
	if info := s.Settings.Get().Registry; info.Enabled {
		if repos, err := s.Registry.Repos(ctx); err == nil {
			addr := s.Registry.Address()
			for _, rp := range repos {
				if strings.Contains(strings.ToLower(rp.Name), strings.ToLower(q)) && len(out) < 5 {
					out = append(out, dockerops.SearchResult{Name: addr + "/" + rp.Name, Description: fmt.Sprintf("In Dockhand's registry · %d tag%s", rp.Tags, map[bool]string{true: "", false: "s"}[rp.Tags == 1]), Private: true})
				}
			}
		}
	}
	ok(w, append(out, dockerops.Search(ctx, q, 8)...))
}

func (s *Server) imageInspect(w http.ResponseWriter, r *http.Request) {
	img := strings.TrimSpace(r.URL.Query().Get("image"))
	if img == "" {
		writeErr(w, http.StatusBadRequest, "image is required")
		return
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()
	ok(w, dockerops.InspectRemote(ctx, img))
}

// ─── Volumes ────────────────────────────────────────────────────────────────

func (s *Server) listVolumes(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	list, err := s.Ops.Volumes(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) deleteVolume(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	if err := s.Ops.RemoveVolume(r.Context(), id, chi.URLParam(r, "name")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) backupVolumes(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct {
		Names []string `json:"names"`
	}
	if !decode(w, r, &in) {
		return
	}
	jid, err := s.Ops.BackupVolumes(r.Context(), id, in.Names, actor(r))
	jobRef(w, jid, err)
}

// ─── Networks ───────────────────────────────────────────────────────────────

func (s *Server) listNetworks(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	list, err := s.Ops.Networks(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}

func (s *Server) createNetwork(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in model.NetworkInput
	if !decode(w, r, &in) {
		return
	}
	n, err := s.Ops.CreateNetwork(r.Context(), id, in)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, n)
}

func (s *Server) inspectNetwork(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	raw, err := s.Ops.InspectNetwork(r.Context(), id, chi.URLParam(r, "nid"))
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(raw)
}

func (s *Server) deleteNetwork(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	if err := s.Ops.RemoveNetwork(r.Context(), id, chi.URLParam(r, "nid")); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

func (s *Server) pruneNetworks(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	removed, err := s.Ops.PruneNetworks(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, map[string][]string{"removed": removed})
}

func (s *Server) connectNetwork(w http.ResponseWriter, r *http.Request)    { s.netMember(w, r, true) }
func (s *Server) disconnectNetwork(w http.ResponseWriter, r *http.Request) { s.netMember(w, r, false) }

func (s *Server) netMember(w http.ResponseWriter, r *http.Request, connect bool) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	var in struct{ Container string }
	if !decode(w, r, &in) {
		return
	}
	if in.Container == "" {
		writeErr(w, http.StatusBadRequest, "container is required")
		return
	}
	if err := s.Ops.ConnectNetwork(r.Context(), id, chi.URLParam(r, "nid"), in.Container, connect); err != nil {
		fail(w, err)
		return
	}
	empty(w)
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	j, err := s.Jobs.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, j)
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.Jobs.List(r.Context(), limit)
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, list)
}
