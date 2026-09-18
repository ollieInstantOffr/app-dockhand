package monitor

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"dockhand/internal/alerts"
	"dockhand/internal/model"
)

func (m *Monitor) updateLoop(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(2 * time.Minute):
	}
	t := time.NewTicker(updateInterval)
	defer t.Stop()
	for {
		m.CheckAllUpdates(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckAllUpdates checks image updates on every online host.
func (m *Monitor) CheckAllUpdates(ctx context.Context) {
	list, err := m.hosts.List(ctx)
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	for _, r := range list {
		if r.Status != "online" && r.Status != "degraded" {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if err := m.CheckUpdates(ctx, id); err != nil {
				slog.Debug("update check failed", "host", id, "err", err)
			}
		}(r.ID)
	}
	wg.Wait()
}

// digestOf returns the digest part of "repo@sha256:…".
func digestOf(repoDigest string) string {
	if i := strings.LastIndex(repoDigest, "@"); i >= 0 {
		return repoDigest[i+1:]
	}
	return repoDigest
}

// CheckUpdates compares running containers' image digests with the registry.
// Only the images in `only` are checked when it is non-empty.
func (m *Monitor) CheckUpdates(ctx context.Context, hostID string, only ...string) error {
	conn, err := m.conns.Get(ctx, hostID)
	if err != nil {
		return err
	}
	cli := conn.Docker()
	images := map[string]string{} // ref → image id
	for _, c := range m.Containers(hostID) {
		if c.State != "running" || strings.HasPrefix(c.Image, "sha256:") || strings.Contains(c.Image, "@") {
			continue
		}
		if len(only) > 0 && !containsStr(only, c.Image) {
			continue
		}
		images[c.Image] = c.ImageID
	}
	refs := make([]string, 0, len(images))
	for r := range images {
		refs = append(refs, r)
	}
	results := make([]*updateEntry, len(refs))
	parallel(ctx, len(refs), 4, func(i int) {
		ref := refs[i]
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		ins, err := cli.ImageInspect(cctx, images[ref])
		if err != nil || len(ins.RepoDigests) == 0 {
			return // locally built or unknown — can't compare
		}
		dist, err := cli.DistributionInspect(cctx, ref, "")
		if err != nil {
			return
		}
		remote := dist.Descriptor.Digest.String()
		upToDate := false
		for _, rd := range ins.RepoDigests {
			if digestOf(rd) == remote {
				upToDate = true
				break
			}
		}
		results[i] = &updateEntry{available: !upToDate, checkedAt: time.Now()}
	})
	m.mu.Lock()
	s := m.hs(hostID)
	for i, ref := range refs {
		if results[i] != nil {
			s.updates[ref] = *results[i]
		}
	}
	m.applyCachedUpdates(s, s.containers)
	count := 0
	names := []string{}
	for _, c := range s.containers {
		if c.Update.Available {
			count++
			names = append(names, c.Name)
		}
	}
	m.mu.Unlock()

	bg := context.Background()
	var hostName string
	_ = m.db.QueryRow(bg, `SELECT name FROM hosts WHERE id::text = $1`, hostID).Scan(&hostName)
	if count > 0 {
		text := strings.Join(names, ", ")
		if len(names) > 5 {
			text = strings.Join(names[:5], ", ") + fmt.Sprintf(" and %d more", len(names)-5)
		}
		m.alerts.Raise(bg, alerts.Spec{Key: "updates:" + hostID, Severity: "info", Kind: "updates",
			Title: fmt.Sprintf("%d image update%s available on %s", count, plural(count), hostName), Text: text,
			HostID: hostID, Action: "Review updates", Href: "/hosts/" + hostID + "?tab=containers", Pref: alerts.PrefUpdates})
	} else {
		m.alerts.Resolve(bg, "updates:"+hostID)
	}
	return nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func containsStr(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// applyCachedUpdates copies update-check results onto containers. Caller holds m.mu.
func (m *Monitor) applyCachedUpdates(s *hostState, ctrs []model.Container) {
	for i := range ctrs {
		c := &ctrs[i]
		c.Update.Tag = ImageTag(c.Image)
		if u, ok := s.updates[c.Image]; ok {
			t := u.checkedAt
			c.Update.CheckedAt = &t
			// An update is only "available" if the container still runs the checked image.
			c.Update.Available = u.available
		}
	}
}

// ClearUpdate marks an image as current after it was pulled/updated.
func (m *Monitor) ClearUpdate(hostID, image string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.hs(hostID)
	s.updates[image] = updateEntry{available: false, checkedAt: time.Now()}
	m.applyCachedUpdates(s, s.containers)
}
