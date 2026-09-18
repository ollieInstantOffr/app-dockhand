package monitor

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"

	"dockhand/internal/alerts"
)

var recordedActions = map[string]bool{
	"create": true, "start": true, "restart": true, "stop": true, "die": true, "kill": true, "pause": true,
	"unpause": true, "oom": true, "destroy": true, "rename": true, "update": true,
}

func (m *Monitor) eventsSupervisor(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		m.syncEventStreams(ctx)
		select {
		case <-ctx.Done():
			m.evMu.Lock()
			for _, c := range m.evCancel {
				c()
			}
			m.evMu.Unlock()
			return
		case <-t.C:
		}
	}
}

func (m *Monitor) syncEventStreams(ctx context.Context) {
	list, err := m.hosts.List(ctx)
	if err != nil {
		return
	}
	want := map[string]bool{}
	for _, r := range list {
		if r.Status == "online" || r.Status == "degraded" {
			want[r.ID] = true
		}
	}
	m.evMu.Lock()
	defer m.evMu.Unlock()
	for id, cancel := range m.evCancel {
		if !want[id] {
			cancel()
			delete(m.evCancel, id)
		}
	}
	for id := range want {
		if _, ok := m.evCancel[id]; ok {
			continue
		}
		sctx, cancel := context.WithCancel(ctx)
		m.evCancel[id] = cancel
		go func(id string) {
			m.streamEvents(sctx, id)
			m.evMu.Lock()
			// Only remove our own registration (a newer stream may have replaced it).
			if c, ok := m.evCancel[id]; ok && sctx.Err() == nil {
				c()
				delete(m.evCancel, id)
			}
			m.evMu.Unlock()
		}(id)
	}
}

func (m *Monitor) stopEvents(hostID string) {
	m.evMu.Lock()
	if c, ok := m.evCancel[hostID]; ok {
		c()
		delete(m.evCancel, hostID)
	}
	m.evMu.Unlock()
}

func (m *Monitor) streamEvents(ctx context.Context, hostID string) {
	gctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := m.conns.Get(gctx, hostID)
	cancel()
	if err != nil {
		return
	}
	f := filters.NewArgs(filters.Arg("type", string(events.ContainerEventType)))
	msgs, errs := conn.Docker().Events(ctx, events.ListOptions{Filters: f})
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-errs:
			if err != nil && ctx.Err() == nil {
				slog.Debug("docker events stream ended", "host", hostID, "err", err)
			}
			return
		case msg := <-msgs:
			m.handleEvent(ctx, hostID, msg)
		}
	}
}

// EventAction renders a Docker event action for the event log.
func EventAction(msg events.Message) string {
	a := string(msg.Action)
	switch {
	case a == "die":
		if code := msg.Actor.Attributes["exitCode"]; code != "" {
			return "die (exit " + code + ")"
		}
	}
	return a
}

func (m *Monitor) handleEvent(ctx context.Context, hostID string, msg events.Message) {
	action := string(msg.Action)
	base := action
	if i := strings.Index(base, ":"); i >= 0 {
		base = base[:i]
	}
	name := msg.Actor.Attributes["name"]
	if name == "" {
		return
	}
	if !recordedActions[base] && base != "health_status" {
		return
	}
	at := time.Unix(0, msg.TimeNano)
	if msg.TimeNano == 0 {
		at = time.Unix(msg.Time, 0)
	}
	ours := m.expectedRecently(hostID, name)
	key := hostID + "|" + name
	bg := context.Background()

	switch base {
	case "stop", "kill":
		m.evMu.Lock()
		m.stopping[key] = time.Now()
		m.evMu.Unlock()
	}

	lifecycle := base != "health_status" && base != "oom"
	if !(ours && lifecycle) {
		if _, err := m.db.Exec(bg, `INSERT INTO container_events (host_id, container, action, actor, at) VALUES ($1, $2, $3, 'docker', $4)`,
			hostID, name, EventAction(msg), at); err != nil {
			slog.Warn("record docker event", "err", err)
		}
	}

	hostName := ""
	_ = m.db.QueryRow(bg, `SELECT name FROM hosts WHERE id::text = $1`, hostID).Scan(&hostName)
	switch {
	case base == "die":
		code := msg.Actor.Attributes["exitCode"]
		m.evMu.Lock()
		st, stopped := m.stopping[key]
		delete(m.stopping, key)
		m.evMu.Unlock()
		userStop := ours || (stopped && time.Since(st) < time.Minute)
		if code != "" && code != "0" && !userStop {
			m.alerts.Raise(bg, alerts.Spec{Key: "container_exited:" + hostID + ":" + name, Severity: "crit", Kind: "container_exited",
				Title: fmt.Sprintf("%s exited with code %s", name, code), Text: fmt.Sprintf("Container %s on %s stopped unexpectedly.", name, hostName),
				HostID: hostID, Action: "Open logs", Href: logsHref(hostID, name), Pref: alerts.PrefContainerCrash})
		}
	case base == "oom":
		m.alerts.Raise(bg, alerts.Spec{Key: "container_exited:" + hostID + ":" + name, Severity: "crit", Kind: "container_exited",
			Title: name + " ran out of memory", Text: fmt.Sprintf("Container %s on %s was killed by the OOM killer.", name, hostName),
			HostID: hostID, Action: "Open logs", Href: logsHref(hostID, name), Pref: alerts.PrefContainerCrash})
	case base == "start":
		m.alerts.Resolve(bg, "container_exited:"+hostID+":"+name)
		if cb := m.OnContainerStarted; cb != nil {
			id := msg.Actor.ID
			go func() {
				// Give the poller cache a moment, then check for a healthcheck via inspect.
				ictx, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				has := false
				if conn, err := m.conns.Get(ictx, hostID); err == nil {
					if ins, err := conn.Docker().ContainerInspect(ictx, id); err == nil && ins.Config != nil && ins.Config.Healthcheck != nil &&
						len(ins.Config.Healthcheck.Test) > 0 && ins.Config.Healthcheck.Test[0] != "NONE" {
						has = true
					}
				}
				cb(hostID, name, has)
			}()
		}
	case base == "health_status" && strings.HasSuffix(action, "unhealthy"):
		m.alerts.Raise(bg, alerts.Spec{Key: "unhealthy:" + hostID + ":" + name, Severity: "warn", Kind: "unhealthy",
			Title: name + " is unhealthy", Text: fmt.Sprintf("The health check of %s on %s is failing.", name, hostName),
			HostID: hostID, Action: "Open logs", Href: logsHref(hostID, name), Pref: alerts.PrefUnhealthy})
	case base == "health_status" && strings.HasSuffix(action, " healthy"):
		m.alerts.Resolve(bg, "unhealthy:"+hostID+":"+name)
	case base == "destroy":
		m.alerts.Resolve(bg, "container_exited:"+hostID+":"+name)
		m.alerts.Resolve(bg, "unhealthy:"+hostID+":"+name)
	}
	m.queueRefresh(ctx, hostID)
}
