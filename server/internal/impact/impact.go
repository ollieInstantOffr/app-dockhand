// Package impact answers "what breaks if I touch this?" — the blast radius of
// rebooting a host, taking a stack down, stopping a container, or installing
// operating system updates. It reads what Dockhand already knows: running
// containers, their stacks and published ports, and the uptime monitors
// pointing at them.
package impact

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"dockhand/internal/hosts"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/uptime"
)

type Service struct {
	hosts  *hosts.Store
	mon    *monitor.Monitor
	uptime *uptime.Service
}

func New(hs *hosts.Store, mon *monitor.Monitor, up *uptime.Service) *Service {
	return &Service{hosts: hs, mon: mon, uptime: up}
}

func live(c model.Container) bool {
	return c.State == "running" || c.State == "restarting" || c.State == "paused"
}

// monitorTarget extracts the host and port a monitor watches.
func monitorTarget(m uptime.Monitor) (string, int) {
	t := strings.TrimSpace(m.Target)
	if t == "" {
		return "", 0
	}
	if strings.Contains(t, "://") {
		u, err := url.Parse(t)
		if err != nil {
			return "", 0
		}
		port := 0
		if p := u.Port(); p != "" {
			port, _ = strconv.Atoi(p)
		} else if u.Scheme == "https" {
			port = 443
		} else if u.Scheme == "http" {
			port = 80
		}
		return strings.ToLower(u.Hostname()), port
	}
	host, portStr, ok := strings.Cut(t, ":")
	if !ok {
		return strings.ToLower(t), 0
	}
	port, _ := strconv.Atoi(portStr)
	return strings.ToLower(host), port
}

// watches reports whether a monitor is aimed at this host, optionally at one of the given ports.
func watches(m uptime.Monitor, rec hosts.Record, ports map[int]bool) bool {
	if m.HostID != nil && *m.HostID == rec.ID {
		if ports == nil {
			return true // a host-wide action takes every monitor of that host with it
		}
		if m.Type == "host" {
			return false // the host itself stays up when one container stops
		}
	}
	target, port := monitorTarget(m)
	if target == "" {
		return false
	}
	names := map[string]bool{strings.ToLower(rec.Address): true, strings.ToLower(rec.Name): true}
	if !names[target] && !(m.HostID != nil && *m.HostID == rec.ID) {
		return false
	}
	if ports == nil {
		return true
	}
	return port != 0 && ports[port]
}

func sev(worst, s string) string {
	rank := map[string]int{"info": 0, "warn": 1, "crit": 2}
	if rank[s] > rank[worst] {
		return s
	}
	return worst
}

// build assembles the report for a set of containers that would stop.
func (s *Service) build(ctx context.Context, rec hosts.Record, target, name, action string, stopping []model.Container, extra func(*model.Impact)) (model.Impact, error) {
	out := model.Impact{Target: target, Name: name, Host: rec.Name, Action: action, Severity: "info",
		Stops: []model.ImpactItem{}, Stacks: []model.ImpactItem{}, Monitors: []model.ImpactItem{}, Ports: []model.ImpactItem{}, Depends: []model.ImpactItem{}, Safe: []string{}}

	ports := map[int]bool{}
	stacks := map[string]int{}
	restarts := 0
	for _, c := range stopping {
		if !live(c) {
			continue
		}
		detail := c.Image
		if c.Stack != "" {
			detail = c.Stack + " · " + c.Image
		}
		item := model.ImpactItem{Kind: "container", Name: c.Name, Detail: detail, Host: rec.Name, Severity: "warn", Href: "/hosts/" + rec.ID}
		if c.Health == "healthy" || len(c.Ports) > 0 {
			item.Severity = "crit"
		}
		out.Stops = append(out.Stops, item)
		if c.Stack != "" {
			stacks[c.Stack]++
		}
		for _, p := range c.Ports {
			if p.Host > 0 {
				ports[p.Host] = true
			}
		}
		// A container with a restart policy comes back by itself after a reboot.
		if c.RestartPolicy != "" && c.RestartPolicy != "no" {
			restarts++
		}
	}
	for name, n := range stacks {
		out.Stacks = append(out.Stacks, model.ImpactItem{Kind: "stack", Name: name, Detail: fmt.Sprintf("%d service%s", n, plural(n)), Host: rec.Name, Severity: "warn", Href: "/hosts/" + rec.ID + "?tab=stacks"})
	}
	// The local host is reached through the Docker socket, so its address isn't dialable.
	addr := rec.Address
	if rec.Method == "local" || strings.HasPrefix(addr, "unix://") || addr == "" {
		addr = rec.Name
	}
	for p := range ports {
		out.Ports = append(out.Ports, model.ImpactItem{Kind: "port", Name: fmt.Sprintf("%s:%d", addr, p), Detail: "published port stops answering", Host: rec.Name, Severity: "warn"})
	}

	// Uptime monitors are the closest thing to "someone will notice".
	mons, err := s.uptime.All(ctx)
	if err == nil {
		watchPorts := ports
		if target == "host" {
			watchPorts = nil
		}
		for _, m := range mons {
			if !m.Enabled || !watches(m, rec, watchPorts) {
				continue
			}
			out.Monitors = append(out.Monitors, model.ImpactItem{Kind: "monitor", Name: m.Name, Detail: m.Target, Host: rec.Name, Severity: "crit", Href: "/uptime"})
		}
	}

	if extra != nil {
		extra(&out)
	}

	sortItems(out.Stops)
	sortItems(out.Stacks)
	sortItems(out.Monitors)
	sortItems(out.Ports)
	sortItems(out.Depends)

	for _, i := range append(append([]model.ImpactItem{}, out.Stops...), out.Monitors...) {
		out.Severity = sev(out.Severity, i.Severity)
	}
	if restarts > 0 {
		out.Safe = append(out.Safe, fmt.Sprintf("%d container%s come back by themselves (restart policy)", restarts, plural(restarts)))
	}
	if len(out.Stops) == 0 {
		out.Safe = append(out.Safe, "Nothing is running that would stop")
	}
	out.Summary = summarize(out, action)
	return out, nil
}

func summarize(i model.Impact, action string) string {
	verb := map[string]string{"reboot": "Rebooting", "stop": "Stopping", "patch": "Patching", "down": "Taking down"}[action]
	if verb == "" {
		verb = "This"
	}
	if len(i.Stops) == 0 {
		return fmt.Sprintf("%s %s stops nothing that is running.", verb, i.Name)
	}
	parts := []string{fmt.Sprintf("%d container%s stop", len(i.Stops), plural(len(i.Stops)))}
	if n := len(i.Stacks); n > 0 {
		parts = append(parts, fmt.Sprintf("%d stack%s", n, plural(n)))
	}
	if n := len(i.Ports); n > 0 {
		parts = append(parts, fmt.Sprintf("%d published port%s", n, plural(n)))
	}
	if n := len(i.Monitors); n > 0 {
		parts = append(parts, fmt.Sprintf("%d uptime check%s will fail", n, plural(n)))
	}
	return fmt.Sprintf("%s %s: %s.", verb, i.Name, strings.Join(parts, ", "))
}

func sortItems(list []model.ImpactItem) {
	rank := map[string]int{"crit": 0, "warn": 1, "info": 2}
	sort.SliceStable(list, func(a, b int) bool {
		if rank[list[a].Severity] != rank[list[b].Severity] {
			return rank[list[a].Severity] < rank[list[b].Severity]
		}
		return strings.ToLower(list[a].Name) < strings.ToLower(list[b].Name)
	})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// Host is the blast radius of rebooting or patching a whole host.
func (s *Service) Host(ctx context.Context, hostID, action string) (model.Impact, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.Impact{}, err
	}
	if action == "" {
		action = "reboot"
	}
	return s.build(ctx, rec, "host", rec.Name, action, s.mon.Containers(rec.ID), func(out *model.Impact) {
		if action == "reboot" {
			out.Safe = append(out.Safe, "The host comes back on its own after the reboot")
		}
	})
}

// Stack is the blast radius of taking one compose stack down.
func (s *Service) Stack(ctx context.Context, hostID, name, action string) (model.Impact, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.Impact{}, err
	}
	all := s.mon.Containers(rec.ID)
	var mine []model.Container
	for _, c := range all {
		if c.Stack == name {
			mine = append(mine, c)
		}
	}
	if action == "" {
		action = "down"
	}
	return s.build(ctx, rec, "stack", name, action, mine, func(out *model.Impact) {
		out.Depends = append(out.Depends, dependents(rec, all, mine)...)
	})
}

// Container is the blast radius of stopping or removing one container.
func (s *Service) Container(ctx context.Context, hostID, cid, action string) (model.Impact, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.Impact{}, err
	}
	all := s.mon.Containers(rec.ID)
	var mine []model.Container
	for _, c := range all {
		if c.ID == cid || strings.HasPrefix(c.ID, cid) || c.Name == cid {
			mine = append(mine, c)
		}
	}
	if len(mine) == 0 {
		return model.Impact{}, fmt.Errorf("container %s not found", cid)
	}
	if action == "" {
		action = "stop"
	}
	return s.build(ctx, rec, "container", mine[0].Name, action, mine, func(out *model.Impact) {
		out.Depends = append(out.Depends, dependents(rec, all, mine)...)
	})
}

// dependents are the other containers in the same stack: compose services talk
// to each other, so they are the ones most likely to notice.
func dependents(rec hosts.Record, all, stopping []model.Container) []model.ImpactItem {
	gone := map[string]bool{}
	stacks := map[string]bool{}
	for _, c := range stopping {
		gone[c.ID] = true
		if c.Stack != "" {
			stacks[c.Stack] = true
		}
	}
	out := []model.ImpactItem{}
	for _, c := range all {
		if gone[c.ID] || !live(c) || c.Stack == "" || !stacks[c.Stack] {
			continue
		}
		out = append(out, model.ImpactItem{Kind: "container", Name: c.Name, Detail: "same stack — may depend on it", Host: rec.Name, Severity: "info", Href: "/hosts/" + rec.ID})
	}
	return out
}
