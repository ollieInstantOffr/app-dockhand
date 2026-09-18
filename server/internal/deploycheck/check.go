package deploycheck

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/distribution/reference"
	"github.com/docker/docker/api/types/container"

	"dockhand/internal/dockerops"
	"dockhand/internal/hosts"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/stacks"
	"dockhand/internal/util"
)

const (
	// Budget keeps the answer under ~8 s; checks that don't finish are skipped.
	checkBudget  = 7500 * time.Millisecond
	connectLimit = 4 * time.Second
	probeLimit   = 3 * time.Second

	diskWarnPct = 90
	diskCritPct = 97
)

// Service runs deploy pre-flight checks.
type Service struct {
	hosts  *hosts.Store
	ops    *dockerops.Service
	stacks *stacks.Service
	mon    *monitor.Monitor
}

func New(hs *hosts.Store, ops *dockerops.Service, st *stacks.Service, mon *monitor.Monitor) *Service {
	return &Service{hosts: hs, ops: ops, stacks: st, mon: mon}
}

// ctrInfo is the part of a container the checks need.
type ctrInfo struct {
	Name    string
	Stack   string // compose project
	WorkDir string // compose working dir
	Ports   []HostPort
}

// hostFacts is what was learned from the host (nil fields = unknown / skipped).
type hostFacts struct {
	containers []ctrInfo
	stackPaths map[string]string // managed stack name → path
	listening  map[int]bool
	pathKind   string // "", "empty", "nonempty", "file"
	pathKnown  bool
}

// Check runs every check that fits in the time budget.
func (s *Service) Check(ctx context.Context, in model.DeployCheckInput) (model.DeployCheckResult, error) {
	in.Kind = strings.TrimSpace(in.Kind)
	switch in.Kind {
	case "git", "image", "compose":
	default:
		return model.DeployCheckResult{}, &dockerops.BadRequest{Msg: "kind must be git, image or compose"}
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Path = strings.TrimSpace(in.Path)
	ctx, cancel := context.WithTimeout(ctx, checkBudget)
	defer cancel()

	var issues []model.DeployIssue
	add := func(i model.DeployIssue) { issues = append(issues, i) }

	// ── Input-only checks ──
	issues = append(issues, nameIssues(in)...)
	if in.Kind == "image" {
		if i := imageIssue(in.Image); i != nil {
			add(*i)
		}
	}
	pathOK := true
	if in.Kind != "image" && in.Path != "" {
		if !path.IsAbs(in.Path) || strings.Contains(in.Path, "..") || path.Clean(in.Path) == "/" {
			pathOK = false
			add(model.DeployIssue{Field: "Path", Severity: "crit", Text: "path must be an absolute directory without “..”"})
		}
	}
	issues = append(issues, envIssues(in.Env, in.RequiredEnv)...)

	// ── Host checks ──
	rec, err := s.hosts.Get(ctx, in.HostID)
	switch {
	case errors.Is(err, hosts.ErrNotFound) || strings.TrimSpace(in.HostID) == "":
		add(model.DeployIssue{Field: "Host", Severity: "crit", Text: "pick a host to deploy to"})
		return result(issues), nil
	case err != nil:
		return model.DeployCheckResult{}, err
	}
	if rec.Status == "offline" {
		msg := rec.Name + " is offline"
		if rec.LastError != "" {
			msg += ": " + util.Truncate(rec.LastError, 160)
		}
		add(model.DeployIssue{Field: "Host", Severity: "crit", Text: msg})
		return result(issues), nil
	}
	if i := diskIssue(rec.Disk, rec.Name); i != nil {
		add(*i)
	}
	cctx, ccancel := context.WithTimeout(ctx, connectLimit)
	conn, err := s.ops.Conn(cctx, rec.ID)
	ccancel()
	if err != nil {
		add(model.DeployIssue{Field: "Host", Severity: "crit", Text: fmt.Sprintf("cannot reach %s: %s", rec.Name, util.Truncate(err.Error(), 160))})
		return result(issues), nil
	}
	checkPath := pathOK && in.Kind != "image" && in.Path != ""
	facts := s.gather(ctx, conn, checkPath, in.Path)

	issues = append(issues, conflictIssues(in, rec.Name, facts)...)
	return result(issues), nil
}

func result(issues []model.DeployIssue) model.DeployCheckResult {
	issues = util.NZ(issues)
	sort.SliceStable(issues, func(i, j int) bool { return issues[i].Severity == "crit" && issues[j].Severity != "crit" })
	ok := true
	for _, i := range issues {
		if i.Severity == "crit" {
			ok = false
		}
	}
	return model.DeployCheckResult{OK: ok, Issues: issues}
}

// gather reads containers, stacks, listening sockets and the target path in parallel.
func (s *Service) gather(ctx context.Context, conn *hosts.Conn, checkPath bool, dir string) hostFacts {
	var f hostFacts
	var wg sync.WaitGroup
	hostID := conn.HostID()

	wg.Add(1)
	go func() {
		defer wg.Done()
		lctx, cancel := context.WithTimeout(ctx, probeLimit)
		defer cancel()
		list, err := conn.Docker().ContainerList(lctx, container.ListOptions{All: true})
		if err != nil {
			f.containers = fromCache(s.mon.Containers(hostID)) // poller cache, if any
			return
		}
		f.containers = fromSummaries(list)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		rows, err := s.stacks.Rows(ctx, hostID)
		if err != nil {
			return
		}
		m := map[string]string{}
		for _, r := range rows {
			m[r.Name] = r.Path
		}
		f.stackPaths = m
	}()

	// The local method runs in Dockhand's own container network namespace, so its
	// sockets say nothing about the host; published container ports still apply.
	if !conn.Local() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ectx, cancel := context.WithTimeout(ctx, probeLimit)
			defer cancel()
			res, err := conn.Exec(ectx, "ss -Hltn 2>/dev/null || netstat -ltn 2>/dev/null || true", nil)
			if err != nil {
				return
			}
			f.listening = ParseListening(res.Stdout)
		}()
	}

	if checkPath {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ectx, cancel := context.WithTimeout(ctx, probeLimit)
			defer cancel()
			q := util.Shq(path.Clean(dir))
			res, err := conn.Exec(ectx, "if [ -d "+q+" ]; then echo dir; ls -A "+q+" 2>/dev/null | head -n 1; elif [ -e "+q+" ]; then echo file; fi", nil)
			if err != nil {
				return
			}
			f.pathKind, f.pathKnown = parsePathProbe(res.Stdout), true
		}()
	}

	wg.Wait()
	return f
}

func parsePathProbe(out string) string {
	lines := strings.Fields(out)
	switch {
	case len(lines) == 0:
		return ""
	case lines[0] == "file":
		return "file"
	case len(lines) == 1:
		return "empty"
	default:
		return "nonempty"
	}
}

func fromSummaries(list []container.Summary) []ctrInfo {
	out := make([]ctrInfo, 0, len(list))
	for _, c := range list {
		ci := ctrInfo{Stack: c.Labels["com.docker.compose.project"], WorkDir: c.Labels["com.docker.compose.project.working_dir"]}
		if len(c.Names) > 0 {
			ci.Name = strings.TrimPrefix(c.Names[0], "/")
		}
		for _, p := range c.Ports {
			if p.PublicPort != 0 {
				ci.Ports = append(ci.Ports, HostPort{Port: int(p.PublicPort), Proto: strings.ToLower(p.Type)})
			}
		}
		out = append(out, ci)
	}
	return out
}

func fromCache(list []model.Container) []ctrInfo {
	if len(list) == 0 {
		return nil
	}
	out := make([]ctrInfo, 0, len(list))
	for _, c := range list {
		ci := ctrInfo{Name: c.Name, Stack: c.Stack, WorkDir: c.Labels["com.docker.compose.project.working_dir"]}
		for _, p := range c.Ports {
			if p.Host != 0 {
				ci.Ports = append(ci.Ports, HostPort{Port: p.Host, Proto: strings.ToLower(p.Proto)})
			}
		}
		out = append(out, ci)
	}
	return out
}

// ─── Individual checks (pure) ───────────────────────────────────────────────

var validComposeName = stacks.ValidName

func nameIssues(in model.DeployCheckInput) []model.DeployIssue {
	if in.Name == "" {
		return []model.DeployIssue{{Field: "Name", Severity: "crit", Text: "a name is required"}}
	}
	if !ValidDockerName(in.Name) {
		return []model.DeployIssue{{Field: "Name", Severity: "crit",
			Text: "names may only contain letters, digits, “_”, “.” and “-”, and must start with a letter or digit"}}
	}
	if in.Kind != "image" && validComposeName(in.Name) != nil {
		fixed := strings.Trim(strings.ReplaceAll(strings.ToLower(in.Name), ".", "-"), "-_")
		i := model.DeployIssue{Field: "Name", Severity: "crit", Text: "compose project names must be lowercase letters, digits, “-” or “_” (max 63)"}
		if fixed != "" && validComposeName(fixed) == nil {
			i.Fix = &model.DeployFix{Label: "Rename to " + fixed, Patch: model.DeployPatch{Name: fixed}}
		}
		return []model.DeployIssue{i}
	}
	return nil
}

func imageIssue(img string) *model.DeployIssue {
	img = strings.TrimSpace(img)
	if img == "" {
		return &model.DeployIssue{Field: "Image", Severity: "crit", Text: "an image is required"}
	}
	if _, err := reference.ParseNormalizedNamed(img); err != nil {
		return &model.DeployIssue{Field: "Image", Severity: "crit", Text: fmt.Sprintf("“%s” is not a valid image reference", img)}
	}
	return nil
}

func envIssues(env []model.KV, required []string) []model.DeployIssue {
	vals := map[string]string{}
	for _, kv := range env {
		vals[strings.TrimSpace(kv.K)] = kv.V
	}
	var out []model.DeployIssue
	seen := map[string]bool{}
	for _, k := range required {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] || strings.TrimSpace(vals[k]) != "" {
			continue
		}
		seen[k] = true
		i := model.DeployIssue{Field: k, Severity: "crit", Text: "required by .env.example"}
		if IsSecretKey(k) {
			i.Fix = &model.DeployFix{Label: "Generate", Patch: model.DeployPatch{Env: []model.KV{{K: k, V: GenerateSecret()}}}}
		}
		out = append(out, i)
	}
	return out
}

func diskIssue(pct float64, host string) *model.DeployIssue {
	switch {
	case pct >= diskCritPct:
		return &model.DeployIssue{Field: "Disk", Severity: "crit", Text: fmt.Sprintf("%s's disk is %.0f%% full — the deploy will likely fail", host, pct)}
	case pct >= diskWarnPct:
		return &model.DeployIssue{Field: "Disk", Severity: "warn", Text: fmt.Sprintf("%s's disk is %.0f%% full", host, pct)}
	}
	return nil
}

// requestedPorts collects host ports from the form rows and the compose content.
func requestedPorts(in model.DeployCheckInput) []HostPort {
	all := FormHostPorts(in.Ports)
	if in.Kind != "image" && strings.TrimSpace(in.ComposeFile) != "" {
		env := map[string]string{}
		for _, kv := range in.Env {
			env[strings.TrimSpace(kv.K)] = kv.V
		}
		all = append(all, ComposeHostPorts([]byte(in.ComposeFile), env)...)
	}
	seen := map[string]bool{}
	out := all[:0]
	for _, p := range all {
		if !seen[p.key()] {
			seen[p.key()] = true
			out = append(out, p)
		}
	}
	return out
}

// conflictIssues checks name, port and path conflicts against what the host reported.
func conflictIssues(in model.DeployCheckInput, hostName string, f hostFacts) []model.DeployIssue {
	var out []model.DeployIssue
	sameDeploy := func(c ctrInfo) bool {
		if in.Kind == "image" {
			return c.Name == in.Name
		}
		return c.Stack == in.Name
	}

	// Name.
	if in.Name != "" && ValidDockerName(in.Name) {
		if in.Kind == "image" && f.containers != nil {
			taken := map[string]bool{}
			for _, c := range f.containers {
				taken[c.Name] = true
			}
			if taken[in.Name] {
				n := NextFreeName(in.Name, taken)
				out = append(out, model.DeployIssue{Field: "Name", Severity: "crit",
					Text: fmt.Sprintf("a container named %s already exists on %s", in.Name, hostName),
					Fix:  &model.DeployFix{Label: "Rename to " + n, Patch: model.DeployPatch{Name: n}}})
			}
		}
		if in.Kind != "image" && (f.containers != nil || f.stackPaths != nil) {
			taken := map[string]bool{}
			for n := range f.stackPaths {
				taken[n] = true
			}
			for _, c := range f.containers {
				if c.Stack != "" {
					taken[c.Stack] = true
				}
			}
			if taken[in.Name] {
				n := NextFreeName(in.Name, taken)
				out = append(out, model.DeployIssue{Field: "Name", Severity: "warn",
					Text: fmt.Sprintf("a stack named %s already exists on %s — it will be updated in place", in.Name, hostName),
					Fix:  &model.DeployFix{Label: "Rename to " + n, Patch: model.DeployPatch{Name: n}}})
			}
		}
	}

	// Ports.
	req := requestedPorts(in)
	if len(req) > 0 {
		owner := map[string]string{} // "port/proto" → container
		ownPorts := map[int]bool{}   // ports the redeployed stack/container already publishes
		taken := map[int]bool{}
		for _, c := range f.containers {
			for _, p := range c.Ports {
				if sameDeploy(c) {
					ownPorts[p.Port] = true
					continue
				}
				if _, ok := owner[p.key()]; !ok {
					owner[p.key()] = c.Name
				}
				taken[p.Port] = true
			}
		}
		for p := range f.listening {
			taken[p] = true
		}
		for _, p := range req {
			taken[p.Port] = true
		}
		for _, p := range req {
			text := ""
			if c, ok := owner[p.key()]; ok {
				text = fmt.Sprintf("already used by %s on %s", c, hostName)
			} else if p.Proto == "tcp" && f.listening[p.Port] && !ownPorts[p.Port] {
				text = "in use on the host"
			}
			if text == "" {
				continue
			}
			i := model.DeployIssue{Field: fmt.Sprintf("Port %d", p.Port), Severity: "crit", Text: text}
			if !p.Range {
				if free := NextFreePort(p.Port, taken); free > 0 {
					taken[free] = true
					i.Fix = &model.DeployFix{Label: fmt.Sprintf("Use %d", free),
						Patch: model.DeployPatch{Ports: []model.PortPatch{{From: fmt.Sprint(p.Port), To: fmt.Sprint(free)}}}}
				}
			}
			out = append(out, i)
		}
	}

	// Path.
	if f.pathKnown && in.Kind != "image" && in.Path != "" {
		dir := path.Clean(in.Path)
		switch f.pathKind {
		case "file":
			out = append(out, model.DeployIssue{Field: "Path", Severity: "crit", Text: dir + " exists and is not a directory"})
		case "nonempty":
			if !isOwnDir(in.Name, dir, f) {
				out = append(out, model.DeployIssue{Field: "Path", Severity: "warn", Text: "directory exists and is not empty — files will be overwritten"})
			}
		}
	}
	return out
}

// isOwnDir reports whether dir already belongs to the stack being (re)deployed.
func isOwnDir(name, dir string, f hostFacts) bool {
	if p, ok := f.stackPaths[name]; ok && path.Clean(p) == dir {
		return true
	}
	for _, c := range f.containers {
		if c.Stack == name && c.WorkDir != "" && path.Clean(c.WorkDir) == dir {
			return true
		}
	}
	return false
}
