package machines

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"dockhand/internal/model"
)

// Patch impact: before installing updates, say what they will disturb. Package
// names carry most of the answer — a docker package restarts the daemon and
// every container with it, a kernel needs a reboot, libc restarts nearly
// everything — and `needrestart` tells us what is already waiting.

type effect struct {
	kind   string // docker | reboot | services | ssh | none
	detail string
}

// rules maps a package name to what installing it disturbs. Longest prefix wins.
var rules = []struct {
	prefix string
	effect effect
}{
	{"linux-image", effect{"reboot", "new kernel — takes effect after a reboot"}},
	{"linux-headers", effect{"none", "kernel headers — nothing restarts"}},
	{"linux-modules", effect{"reboot", "kernel modules — takes effect after a reboot"}},
	{"linux-generic", effect{"reboot", "new kernel — takes effect after a reboot"}},
	{"linux-firmware", effect{"reboot", "firmware — takes effect after a reboot"}},
	{"docker-ce-cli", effect{"none", "the docker command only — containers keep running"}},
	{"docker-compose-plugin", effect{"none", "compose plugin — containers keep running"}},
	{"docker-buildx-plugin", effect{"none", "buildx plugin — containers keep running"}},
	{"docker-ce", effect{"docker", "restarts the Docker daemon"}},
	{"docker.io", effect{"docker", "restarts the Docker daemon"}},
	{"containerd", effect{"docker", "restarts containerd under Docker"}},
	{"runc", effect{"docker", "container runtime — Docker restarts"}},
	{"systemd", effect{"reboot", "init system — a reboot is the safe way to finish"}},
	{"libc6", effect{"services", "core C library — most services restart"}},
	{"libssl", effect{"services", "TLS library — services using it restart"}},
	{"openssl", effect{"services", "TLS library — services using it restart"}},
	{"zlib1g", effect{"services", "compression library — services using it restart"}},
	{"openssh-server", effect{"ssh", "restarts sshd (open sessions survive)"}},
	{"dbus", effect{"reboot", "system bus — a reboot is the safe way to finish"}},
}

// serviceFor guesses the systemd unit a package manages, when the machine runs one by that name.
func serviceFor(pkg string, units map[string]bool) string {
	base := pkg
	for _, cut := range []string{"-server", "-core", "-common", "-bin", "-data"} {
		base = strings.TrimSuffix(base, cut)
	}
	for _, cand := range []string{pkg, base, strings.SplitN(base, "-", 2)[0]} {
		if cand != "" && units[cand] {
			return cand
		}
	}
	return ""
}

func classify(pkg string, units map[string]bool) (effect, string) {
	best := effect{"none", ""}
	bestLen := 0
	for _, r := range rules {
		if strings.HasPrefix(pkg, r.prefix) && len(r.prefix) > bestLen {
			best, bestLen = r.effect, len(r.prefix)
		}
	}
	if bestLen > 0 {
		return best, ""
	}
	if svc := serviceFor(pkg, units); svc != "" {
		return effect{"services", "restarts " + svc}, svc
	}
	return effect{"none", "no service restart expected"}, ""
}

// PatchImpact predicts what installing these packages would restart. With no
// package names it uses everything pending on the machine.
func (s *Service) PatchImpact(ctx context.Context, hostID string, pkgs []string, securityOnly bool) (model.PatchImpact, error) {
	m, err := s.Get(ctx, hostID, false)
	if err != nil {
		return model.PatchImpact{}, err
	}
	out := model.PatchImpact{Services: []string{}, Pending: m.Pending, Containers: []model.ImpactItem{}, Details: []model.PatchPackage{}, Severity: "info"}
	if out.Pending == nil {
		out.Pending = []string{}
	}

	want := map[string]bool{}
	for _, p := range pkgs {
		want[p] = true
	}
	units := map[string]bool{}
	for _, sv := range m.Services {
		if sv.Active == "running" {
			units[sv.Name] = true
		}
	}

	services := map[string]bool{}
	for _, p := range m.Packages {
		if len(want) > 0 && !want[p.Name] {
			continue
		}
		if securityOnly && !p.Security {
			continue
		}
		out.Packages++
		if p.Security {
			out.Security++
		}
		e, svc := classify(p.Name, units)
		switch e.kind {
		case "docker":
			out.Docker = true
		case "reboot":
			out.Reboot = true
		case "services":
			if svc != "" {
				services[svc] = true
			}
		}
		if e.kind != "none" {
			out.Details = append(out.Details, model.PatchPackage{Name: p.Name, Effect: e.kind, Detail: e.detail, Service: svc})
		}
	}
	for svc := range services {
		out.Services = append(out.Services, svc)
	}
	sort.Strings(out.Services)
	sort.SliceStable(out.Details, func(i, j int) bool {
		rank := map[string]int{"docker": 0, "reboot": 1, "services": 2, "ssh": 3, "none": 4}
		if rank[out.Details[i].Effect] != rank[out.Details[j].Effect] {
			return rank[out.Details[i].Effect] < rank[out.Details[j].Effect]
		}
		return out.Details[i].Name < out.Details[j].Name
	})
	if m.Reboot {
		out.Reboot = true
	}

	// If Docker restarts, every container on the machine goes with it.
	if out.Docker && s.Impact != nil {
		if imp, err := s.Impact(ctx, hostID); err == nil {
			out.Containers = imp.Stops
		}
	}

	switch {
	case out.Docker:
		out.Severity = "crit"
	case out.Reboot || len(out.Services) > 0:
		out.Severity = "warn"
	}
	out.Summary = patchSummary(out, m.Name)
	return out, nil
}

func patchSummary(p model.PatchImpact, host string) string {
	if p.Packages == 0 {
		return "Nothing selected."
	}
	parts := []string{fmt.Sprintf("%d update%s on %s", p.Packages, plural(p.Packages), host)}
	if p.Docker {
		n := len(p.Containers)
		parts = append(parts, fmt.Sprintf("Docker restarts — %d container%s stop briefly", n, plural(n)))
	}
	if len(p.Services) > 0 {
		parts = append(parts, fmt.Sprintf("restarts %s", strings.Join(p.Services, ", ")))
	}
	if p.Reboot {
		parts = append(parts, "a reboot is needed to finish")
	}
	if len(parts) == 1 {
		return parts[0] + " — nothing should restart."
	}
	return strings.Join(parts, " · ") + "."
}
