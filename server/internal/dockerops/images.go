package dockerops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/pkg/jsonmessage"

	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/regauth"
	"dockhand/internal/util"
)

// NormalizeRef adds ":latest" when a reference has neither tag nor digest.
func NormalizeRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.Contains(ref, "@") {
		return ref
	}
	slash := strings.LastIndex(ref, "/")
	if strings.LastIndex(ref, ":") > slash {
		return ref
	}
	return ref + ":latest"
}

// Pull pulls an image, logging throttled progress lines like
// "a1b2c3: Downloading 12.4MB/31.2MB". When the API pull is refused for lack
// of credentials it falls back to `docker pull` on the host, which uses the
// host's own `docker login` credentials.
func (s *Service) Pull(ctx context.Context, conn *hosts.Conn, ref string, log func(level, text string)) error {
	ref = NormalizeRef(ref)
	log("cmd", "$ docker pull "+ref)
	auth := regauth.Encoded(ctx, ref)
	if auth != "" {
		log("muted", "using saved credentials for "+regauth.HostOf(ref))
	}
	rd, err := conn.Docker().ImagePull(ctx, ref, image.PullOptions{RegistryAuth: auth})
	if err == nil {
		err = streamPull(rd, log)
		rd.Close()
	}
	if err == nil {
		log("ok", "pulled "+ref)
		return nil
	}
	msg := strings.ToLower(err.Error())
	if !conn.Local() && (strings.Contains(msg, "unauthorized") || strings.Contains(msg, "denied") || strings.Contains(msg, "authentication required")) {
		log("warn", "registry refused anonymous pull; retrying with the host's docker credentials")
		code, xerr := conn.ExecStream(ctx, "docker pull "+util.Shq(ref), nil, func(_, line string) { log("muted", line) })
		if xerr == nil && code == 0 {
			log("ok", "pulled "+ref)
			return nil
		}
	}
	return fmt.Errorf("pull %s: %s", ref, cleanDockerErr(err))
}

func streamPull(rd io.Reader, log func(level, text string)) error {
	dec := json.NewDecoder(rd)
	lastStatus := map[string]string{}
	lastAt := map[string]time.Time{}
	for {
		var m jsonmessage.JSONMessage
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if m.Error != nil {
			return errors.New(m.Error.Message)
		}
		if m.Status == "" {
			continue
		}
		id := m.ID
		if len(id) > 12 {
			id = id[:12]
		}
		line := m.Status
		if id != "" {
			line = id + ": " + m.Status
		}
		progress := m.Progress != nil && m.Progress.Total > 0
		if progress {
			line += fmt.Sprintf(" %s/%s", util.HumanBytes(m.Progress.Current), util.HumanBytes(m.Progress.Total))
			// Throttle progress lines per layer to one per second.
			if lastStatus[id] == m.Status && time.Since(lastAt[id]) < time.Second {
				continue
			}
		} else if lastStatus[id] == m.Status && id != "" {
			continue
		}
		lastStatus[id], lastAt[id] = m.Status, time.Now()
		level := "muted"
		switch {
		case strings.HasPrefix(m.Status, "Pull complete"), strings.HasPrefix(m.Status, "Already exists"):
			level = "info"
		case strings.HasPrefix(m.Status, "Status:"), strings.HasPrefix(m.Status, "Digest:"):
			level = "info"
		}
		log(level, line)
	}
}

// Images lists a host's images, one entry per tag.
func (s *Service) Images(ctx context.Context, hostID string) ([]model.Image, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	cli := conn.Docker()
	lctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	imgs, err := cli.ImageList(lctx, image.ListOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	ctrs, err := cli.ContainerList(lctx, container.ListOptions{All: true})
	if err != nil {
		return nil, wrap(err)
	}
	uses := map[string]int{}
	for _, c := range ctrs {
		uses[c.ImageID]++
	}
	out := []model.Image{}
	for _, im := range imgs {
		short := strings.TrimPrefix(im.ID, "sha256:")
		if len(short) > 12 {
			short = short[:12]
		}
		base := model.Image{ID: im.ID, ShortID: short, Size: im.Size, CreatedAt: time.Unix(im.Created, 0).UTC(), Containers: uses[im.ID]}
		tags := []string{}
		for _, t := range im.RepoTags {
			if t != "<none>:<none>" {
				tags = append(tags, t)
			}
		}
		if len(tags) == 0 {
			b := base
			b.Repo, b.Tag, b.Dangling = "<none>", "<none>", true
			if len(im.RepoDigests) > 0 {
				b.Repo = strings.SplitN(im.RepoDigests[0], "@", 2)[0]
				b.Dangling = false
			}
			out = append(out, b)
			continue
		}
		for _, t := range tags {
			b := base
			i := strings.LastIndex(t, ":")
			if i > strings.LastIndex(t, "/") {
				b.Repo, b.Tag = t[:i], t[i+1:]
			} else {
				b.Repo, b.Tag = t, "latest"
			}
			out = append(out, b)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Repo != out[j].Repo {
			return out[i].Repo < out[j].Repo
		}
		return out[i].Tag < out[j].Tag
	})
	return out, nil
}

// RemoveImage deletes an image by id or reference.
func (s *Service) RemoveImage(ctx context.Context, hostID, ref string, force bool) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	_, err = conn.Docker().ImageRemove(rctx, ref, image.RemoveOptions{Force: force, PruneChildren: true})
	return wrap(err)
}

// PruneResult is the prune response.
type PruneResult struct {
	Count     int    `json:"count"`
	Reclaimed uint64 `json:"reclaimed"`
}

// PruneImages removes all unused images (not just dangling).
func (s *Service) PruneImages(ctx context.Context, hostID string) (PruneResult, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return PruneResult{}, err
	}
	pctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	rep, err := conn.Docker().ImagesPrune(pctx, filters.NewArgs(filters.Arg("dangling", "false")))
	if err != nil {
		return PruneResult{}, wrap(err)
	}
	n := 0
	for _, d := range rep.ImagesDeleted {
		if d.Deleted != "" {
			n++
		}
	}
	s.mon.Refresh(context.Background(), hostID)
	return PruneResult{Count: n, Reclaimed: rep.SpaceReclaimed}, nil
}

// PullInput is the POST /api/images/pull body.
type PullInput struct {
	Image   string   `json:"image"`
	Tag     string   `json:"tag"`
	HostIDs []string `json:"hostIds"`
}

// PullJob pulls an image on several hosts (job).
func (s *Service) PullJob(ctx context.Context, in PullInput, actor string) (string, error) {
	ref := strings.TrimSpace(in.Image)
	if ref == "" {
		return "", bad("image is required")
	}
	if t := strings.TrimSpace(in.Tag); t != "" && !strings.Contains(ref, "@") {
		slash := strings.LastIndex(ref, "/")
		if i := strings.LastIndex(ref, ":"); i > slash {
			ref = ref[:i]
		}
		ref += ":" + t
	}
	ref = NormalizeRef(ref)
	if len(in.HostIDs) == 0 {
		return "", bad("select at least one host")
	}
	type h struct{ id, name string }
	targets := []h{}
	for _, id := range in.HostIDs {
		r, err := s.hosts.Get(ctx, id)
		if err != nil {
			return "", err
		}
		targets = append(targets, h{r.ID, r.Name})
	}
	hostID := ""
	if len(targets) == 1 {
		hostID = targets[0].id
	}
	plan := []string{}
	for _, t := range targets {
		plan = append(plan, "Pull on "+t.name)
	}
	return s.jobs.Start(jobs.Spec{Kind: "pull", Title: "Pull " + ref, HostID: hostID, Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error {
			failed := 0
			for _, t := range targets {
				j.Step("Pull on "+t.name, ref)
				conn, err := s.conns.Get(ctx, t.id)
				if err == nil {
					err = s.Pull(ctx, conn, ref, func(level, text string) { j.Log(level, "["+t.name+"] "+text) })
				}
				if err != nil {
					j.Fail(err.Error())
					j.Logf("error", "[%s] %v", t.name, err)
					failed++
					continue
				}
				s.mon.ClearUpdate(t.id, ref)
				go s.mon.CheckUpdates(context.Background(), t.id, ref)
			}
			j.Set("image", ref)
			if failed > 0 {
				return fmt.Errorf("pull failed on %d of %d hosts", failed, len(targets))
			}
			return nil
		})
}
