package hosts

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
)

// Helper containers (label dockhand.helper=<kind>) are short-lived containers
// Dockhand starts for host shells, volume backups, git reads and self-updates.
// Each one is owned by the API process that started it, so any left over from
// an earlier process (a crash, a restart mid-session) is an orphan.

// processStart marks this API process; helpers created before it have no owner.
var processStart = time.Now()

// activeShells holds the ids of host-shell helpers with an open terminal.
var activeShells sync.Map

// sweepHelpers removes orphaned helper containers on one host.
func sweepHelpers(ctx context.Context, cli *client.Client, host string) {
	list, err := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "dockhand.helper"))})
	if err != nil {
		slog.Debug("sweep helpers", "host", host, "err", err)
		return
	}
	var updaters []container.Summary
	for _, c := range list {
		created := time.Unix(c.Created, 0)
		orphan := false
		switch c.Labels["dockhand.helper"] {
		case "host-shell":
			// A minute's grace covers a shell that is still being attached.
			_, live := activeShells.Load(c.ID)
			orphan = !live && (created.Before(processStart) || time.Since(created) > time.Minute)
		case "backup", "git":
			orphan = created.Before(processStart)
		case "self-update":
			// The updater outlives the API it replaces; keep a running one, and the newest for its logs.
			if c.State != "running" {
				updaters = append(updaters, c)
			}
		}
		if orphan {
			remove(ctx, cli, host, c)
		}
	}
	sort.Slice(updaters, func(i, j int) bool { return updaters[i].Created > updaters[j].Created })
	for i, c := range updaters {
		if i > 0 {
			remove(ctx, cli, host, c)
		}
	}
}

func remove(ctx context.Context, cli *client.Client, host string, c container.Summary) {
	if err := cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}); err != nil {
		slog.Debug("remove helper", "host", host, "id", c.ID[:12], "err", err)
		return
	}
	slog.Info("removed leftover helper container", "host", host, "kind", c.Labels["dockhand.helper"], "id", c.ID[:12], "state", c.State)
}

// SweepHelpers removes orphaned helper containers on every connected host.
func (m *Manager) SweepHelpers(ctx context.Context) {
	m.mu.Lock()
	conns := make([]*Conn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	for _, c := range conns {
		if c.docker == nil {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		sweepHelpers(cctx, c.docker, c.Name())
		cancel()
	}
}

// sweepOnce sweeps a host the first time this process connects to it.
func (m *Manager) sweepOnce(c *Conn) {
	m.mu.Lock()
	if m.swept == nil {
		m.swept = map[string]bool{}
	}
	done := m.swept[c.HostID()]
	m.swept[c.HostID()] = true
	m.mu.Unlock()
	if done || c.docker == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		sweepHelpers(ctx, c.docker, c.Name())
	}()
}
