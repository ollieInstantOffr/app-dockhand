package mcptools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/gitdeploy"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/mcp"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/settings"
	"dockhand/internal/stacks"
	"dockhand/internal/util"
)

// Provider implements mcp.Provider.
type Provider struct {
	db       *db.DB
	settings *settings.Store
	hosts    *hosts.Store
	mon      *monitor.Monitor
	ops      *dockerops.Service
	stacks   *stacks.Service
	git      *gitdeploy.Service
	jobs     *jobs.Runner
	catalog  map[string]mcp.Tool
	ded      dedicated
	oauth    oauthState
}

func New(pool *db.DB, st *settings.Store, hs *hosts.Store, mon *monitor.Monitor, ops *dockerops.Service, sk *stacks.Service,
	git *gitdeploy.Service, jr *jobs.Runner) *Provider {
	cat := map[string]mcp.Tool{}
	for _, t := range mcp.Catalog() {
		cat[t.Name] = t
	}
	return &Provider{db: pool, settings: st, hosts: hs, mon: mon, ops: ops, stacks: sk, git: git, jobs: jr, catalog: cat}
}

// ToolInfos returns the catalog as settings defaults input.
func ToolInfos() []settings.ToolInfo {
	out := []settings.ToolInfo{}
	for _, t := range mcp.Catalog() {
		out = append(out, settings.ToolInfo{Name: t.Name, Writes: t.Writes})
	}
	return out
}

// Enabled implements mcp.Provider.
func (p *Provider) Enabled() bool { return p.settings.Get().MCP.Enabled }

func allowedByKey(k Key, t mcp.Tool) bool {
	switch k.Scope {
	case "full":
		return true
	case "custom":
		return util.Contains(k.Groups, t.Group)
	default: // read
		return !t.Writes
	}
}

// Tools implements mcp.Provider.
func (p *Provider) Tools(keyID string) []mcp.Tool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	k, err := p.key(ctx, keyID)
	if err != nil || k.Revoked {
		return nil
	}
	prefs := p.settings.Get().MCP.Tools
	out := []mcp.Tool{}
	for _, t := range mcp.Catalog() {
		if pref, ok := prefs[t.Name]; ok && !pref.Enabled {
			continue
		}
		if allowedByKey(k, t) {
			out = append(out, t)
		}
	}
	return out
}

// callCtx carries per-call state.
type callCtx struct {
	key   Key
	args  map[string]any
	actor string
}

func (c *callCtx) str(name string) string {
	v, _ := c.args[name]
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}

func (c *callCtx) boolean(name string) bool {
	switch x := c.args[name].(type) {
	case bool:
		return x
	case string:
		return x == "true" || x == "1" || x == "yes"
	}
	return false
}

func (c *callCtx) int(name string, def int) int {
	switch x := c.args[name].(type) {
	case int64:
		return int(x)
	case float64:
		return int(x)
	case string:
		var n int
		if _, err := fmt.Sscan(x, &n); err == nil {
			return n
		}
	}
	return def
}

func (c *callCtx) strs(name string) []string {
	out := []string{}
	switch x := c.args[name].(type) {
	case []any:
		for _, v := range x {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
	case string:
		for _, s := range strings.Split(x, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// userErr is a tool-level error shown to the model.
type userErr struct{ msg string }

func (e *userErr) Error() string { return e.msg }

func uerr(format string, a ...any) error { return &userErr{msg: fmt.Sprintf(format, a...)} }

// host resolves and authorises a host argument.
func (p *Provider) host(ctx context.Context, c *callCtx, ref string) (hosts.Record, error) {
	if ref == "" {
		return hosts.Record{}, uerr("the host argument is required (see list_hosts)")
	}
	r, err := p.hosts.Get(ctx, ref)
	if err != nil {
		// Case-insensitive name match.
		list, lerr := p.hosts.List(ctx)
		if lerr == nil {
			for _, h := range list {
				if strings.EqualFold(h.Name, ref) {
					r, err = h, nil
					break
				}
			}
		}
		if err != nil {
			return r, uerr("unknown host %q (see list_hosts)", ref)
		}
	}
	if !p.hostAllowed(c.key, r) {
		return r, uerr("host %q is not available to this API key", r.Name)
	}
	return r, nil
}

func (p *Provider) hostAllowed(k Key, r hosts.Record) bool {
	if !r.McpExposed {
		return false
	}
	return len(k.HostIDs) == 0 || util.Contains(k.HostIDs, r.ID)
}

func (p *Provider) allowedHosts(ctx context.Context, k Key) ([]hosts.Record, error) {
	list, err := p.hosts.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []hosts.Record{}
	for _, r := range list {
		if p.hostAllowed(k, r) {
			out = append(out, r)
		}
	}
	return out, nil
}

// Call implements mcp.Provider.
func (p *Provider) Call(ctx context.Context, cc mcp.CallContext, name string) (mcp.Result, error) {
	tool, ok := p.catalog[name]
	if !ok {
		return mcp.Result{Text: "unknown tool " + name, IsError: true}, nil
	}
	k, err := p.key(ctx, cc.KeyID)
	if err != nil || k.Revoked || !allowedByKey(k, tool) {
		p.logActivity(cc.KeyID, cc.KeyName, name, "denied", false)
		return mcp.Result{Text: "This API key may not use " + name + ".", IsError: true}, nil
	}
	pref := p.settings.Get().MCP.Tools[name]
	c := &callCtx{key: k, args: cc.Args, actor: "mcp:" + cc.KeyName}
	if c.args == nil {
		c.args = map[string]any{}
	}
	detail := summarize(c.args)
	if tool.Writes && pref.Confirm && !c.boolean("confirm") {
		p.logActivity(cc.KeyID, cc.KeyName, name, "confirmation requested · "+detail, false)
		return mcp.Result{IsError: true, Text: fmt.Sprintf("Confirmation required. This would %s (%s). "+
			"Ask the user to confirm, then call %s again with \"confirm\": true.", describe(name, c), detail, name)}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	text, err := p.run(ctx, name, c)
	if err != nil {
		p.logActivity(cc.KeyID, cc.KeyName, name, detail+" · "+err.Error(), false)
		var ue *userErr
		var br *dockerops.BadRequest
		if errors.As(err, &ue) || errors.As(err, &br) || errors.Is(err, dockerops.ErrNotFound) || errors.Is(err, stacks.ErrNotFound) {
			return mcp.Result{Text: err.Error(), IsError: true}, nil
		}
		return mcp.Result{Text: "Error: " + err.Error(), IsError: true}, nil
	}
	p.logActivity(cc.KeyID, cc.KeyName, name, detail, true)
	return mcp.Result{Text: text}, nil
}

func summarize(args map[string]any) string {
	keys := make([]string, 0, len(args))
	for k := range args {
		if k == "confirm" || k == "content" || k == "env" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, args[k]))
	}
	return util.Truncate(strings.Join(parts, " "), 200)
}

func describe(name string, c *callCtx) string {
	h, ctr, st := c.str("host"), c.str("container"), c.str("stack")
	switch name {
	case "reboot_host":
		return "reboot host " + h + "; every container on it goes down until it is back"
	case "start_container", "stop_container", "restart_container":
		return strings.TrimSuffix(name, "_container") + " container " + ctr + " on " + h
	case "remove_container":
		return "permanently remove container " + ctr + " on " + h
	case "update_container":
		return "pull the latest image for " + ctr + " on " + h + " and recreate it"
	case "stack_action":
		return "run `docker compose " + c.str("action") + "` for stack " + st + " on " + h
	case "update_compose":
		return "overwrite the compose file of stack " + st + " on " + h + " and apply it"
	case "pull_and_rebuild":
		if c.boolean("force") {
			return "reset stack " + st + " on " + h + " to its latest git commit (discarding local changes) and rebuild it"
		}
		return "pull the latest git commit for stack " + st + " on " + h + " and rebuild it"
	case "pull_image":
		return "pull image " + c.str("image")
	case "prune_images":
		return "delete all unused images on " + h
	case "deploy_from_github":
		return "deploy " + c.str("repo") + " to " + h
	case "run_container":
		return "start a new container " + c.str("name") + " from " + c.str("image") + " on " + h
	}
	return "run " + name
}

func js(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// waitJob waits for a job to finish (bounded by ctx) and summarises it.
func (p *Provider) waitJob(ctx context.Context, id string) string {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		j, err := p.jobs.Get(context.Background(), id)
		if err == nil && j.Status != "running" {
			return jobSummary(j)
		}
		select {
		case <-ctx.Done():
			return fmt.Sprintf("Job %s is still running in the background (open Dockhand → Deploy to follow it).", id)
		case <-t.C:
		}
	}
}

func jobSummary(j model.Job) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s (job %s)\n", j.Title, j.Status, j.ID)
	for _, s := range j.Steps {
		fmt.Fprintf(&b, "- [%s] %s %s\n", s.Status, s.Label, s.Sub)
	}
	tail := j.Log
	if len(tail) > 25 {
		tail = tail[len(tail)-25:]
	}
	if len(tail) > 0 {
		b.WriteString("Last log lines:\n")
		for _, l := range tail {
			b.WriteString("  " + l.Text + "\n")
		}
	}
	return b.String()
}

func (p *Provider) run(ctx context.Context, name string, c *callCtx) (string, error) {
	switch name {
	case "list_hosts":
		list, err := p.allowedHosts(ctx, c.key)
		if err != nil {
			return "", err
		}
		type row struct {
			ID, Name, Address, Status, OS, DockerVersion string
			Running, Total, Updates                      int
			CPU, Mem, Disk                               float64
		}
		out := []row{}
		for _, r := range list {
			v := p.mon.HostView(r)
			out = append(out, row{v.ID, v.Name, v.Address, v.Status, v.OS, v.DockerVersion, v.Running, v.Total, v.Updates, v.CPU, v.Mem, v.Disk})
		}
		return js(out), nil

	case "host_stats":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		v := p.mon.HostView(r)
		return js(map[string]any{"name": v.Name, "status": v.Status, "cpuPct": v.CPU, "cpuCores": v.CPUCores,
			"memPct": v.Mem, "memUsed": util.HumanBytes(v.MemUsed), "memTotal": util.HumanBytes(v.MemTotal),
			"diskPct": v.Disk, "diskUsed": util.HumanBytes(v.DiskUsed), "diskTotal": util.HumanBytes(v.DiskTotal),
			"uptime": (time.Duration(v.UptimeSec) * time.Second).String(), "containersRunning": v.Running,
			"containersStopped": v.Total - v.Running, "imageUpdates": v.Updates, "os": v.OS, "kernel": v.Kernel,
			"dockerVersion": v.DockerVersion, "lastSeenAt": v.LastSeenAt, "lastError": v.LastError}), nil

	case "reboot_host":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		if err := p.ops.Reboot(ctx, r.ID); err != nil {
			return "", err
		}
		return "Reboot requested for " + r.Name + ".", nil

	case "list_containers":
		var hs []hosts.Record
		if h := c.str("host"); h != "" {
			r, err := p.host(ctx, c, h)
			if err != nil {
				return "", err
			}
			hs = []hosts.Record{r}
		} else {
			var err error
			if hs, err = p.allowedHosts(ctx, c.key); err != nil {
				return "", err
			}
		}
		all := c.boolean("all")
		type row struct {
			Host, Name, Image, State, Status, Health, Stack string
			Ports                                           []string
			CPU                                             float64
			Mem                                             string
			UpdateAvailable                                 bool `json:",omitempty"`
		}
		out := []row{}
		for _, h := range hs {
			ctrs, err := p.ops.Containers(ctx, h.ID)
			if err != nil {
				continue
			}
			for _, ct := range ctrs {
				if !all && ct.State != "running" {
					continue
				}
				ports := []string{}
				for _, pm := range ct.Ports {
					if pm.Host > 0 {
						ports = append(ports, fmt.Sprintf("%d:%d/%s", pm.Host, pm.Container, pm.Proto))
					} else {
						ports = append(ports, fmt.Sprintf("%d/%s", pm.Container, pm.Proto))
					}
				}
				out = append(out, row{h.Name, ct.Name, ct.Image, ct.State, ct.Status, ct.Health, ct.Stack, ports, ct.CPU,
					util.HumanBytes(ct.MemUsed), ct.Update.Available})
			}
		}
		return js(out), nil

	case "inspect_container":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		d, err := p.ops.Detail(ctx, r.ID, c.str("container"))
		if err != nil {
			return "", err
		}
		for i := range d.Env {
			if d.Env[i].Secret {
				d.Env[i].V = "••••••"
			}
		}
		d.History = model.History{CPU: []float64{}, Mem: []float64{}, NetRx: []float64{}, NetTx: []float64{}}
		if len(d.Events) > 15 {
			d.Events = d.Events[:15]
		}
		return js(d), nil

	case "start_container", "stop_container", "restart_container":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		action := strings.TrimSuffix(name, "_container")
		ct, err := p.ops.Action(ctx, r.ID, c.str("container"), action, c.actor)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s on %s is now %s (%s).", ct.Name, r.Name, ct.State, ct.Status), nil

	case "remove_container":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		if err := p.ops.Remove(ctx, r.ID, c.str("container"), c.boolean("force"), false, c.actor); err != nil {
			return "", err
		}
		return "Removed " + c.str("container") + " on " + r.Name + ".", nil

	case "update_container":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		id, err := p.ops.UpdateContainer(r.ID, c.str("container"), c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "get_logs", "search_logs":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		since := c.str("since")
		tail := fmt.Sprint(c.int("tail", 200))
		q := strings.ToLower(c.str("query"))
		if name == "search_logs" {
			if q == "" {
				return "", uerr("query is required")
			}
			if since == "" {
				since = "24h"
			}
			tail = "20000"
		} else if n := c.int("tail", 200); n < 1 || n > 5000 {
			tail = "200"
		}
		var b strings.Builder
		matches := 0
		lctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		err = p.ops.Logs(lctx, r.ID, c.str("container"), dockerops.LogOpts{Tail: tail, Since: since}, func(l dockerops.LogLine) error {
			if q != "" && !strings.Contains(strings.ToLower(l.Line), q) {
				return nil
			}
			matches++
			if name == "search_logs" && matches > 300 {
				return errStop
			}
			fmt.Fprintf(&b, "%s %s %s\n", l.T.UTC().Format(time.RFC3339), l.Stream, l.Line)
			return nil
		})
		if err != nil && !errors.Is(err, errStop) {
			return "", err
		}
		out := b.String()
		if len(out) > 200_000 {
			out = "… (truncated)\n" + out[len(out)-200_000:]
		}
		if out == "" {
			if name == "search_logs" {
				return "No matching lines.", nil
			}
			return "No log output.", nil
		}
		return out, nil

	case "list_stacks":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		list, err := p.stacks.List(ctx, r.ID)
		if err != nil {
			return "", err
		}
		type row struct {
			Name, Status, Source, Path, Repo, Branch string
			Services                                 []string
		}
		out := []row{}
		for _, s := range list {
			svcs := []string{}
			for _, sv := range s.Services {
				svcs = append(svcs, sv.Name+" ("+sv.State+")")
			}
			out = append(out, row{s.Name, s.Status, s.Source, s.Path, s.Repo, s.Branch, svcs})
		}
		return js(out), nil

	case "get_compose":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		f, err := p.stacks.GetCompose(ctx, r.ID, c.str("stack"))
		if err != nil {
			return "", err
		}
		return "# " + f.Path + "\n" + f.Content, nil

	case "stack_action":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		id, err := p.stacks.Action(ctx, r.ID, c.str("stack"), c.str("action"), c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "pull_and_rebuild":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		id, err := p.git.PullAndRebuild(ctx, r.ID, c.str("stack"), model.StackGitUpdate{Force: c.boolean("force"), PullImages: c.boolean("pull_images"), NoCache: c.boolean("no_cache")}, c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "update_compose":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		id, err := p.stacks.PutCompose(ctx, r.ID, c.str("stack"), c.str("content"), c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "list_images":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		imgs, err := p.ops.Images(ctx, r.ID)
		if err != nil {
			return "", err
		}
		type row struct {
			Repo, Tag, ID, Size string
			Created             time.Time
			InUse, Dangling     bool
		}
		out := []row{}
		for _, im := range imgs {
			out = append(out, row{im.Repo, im.Tag, im.ShortID, util.HumanBytes(im.Size), im.CreatedAt, im.Containers > 0, im.Dangling})
		}
		return js(out), nil

	case "pull_image":
		ids := []string{}
		for _, h := range c.strs("hosts") {
			r, err := p.host(ctx, c, h)
			if err != nil {
				return "", err
			}
			ids = append(ids, r.ID)
		}
		if len(ids) == 0 {
			if h := c.str("host"); h != "" {
				r, err := p.host(ctx, c, h)
				if err != nil {
					return "", err
				}
				ids = append(ids, r.ID)
			}
		}
		id, err := p.ops.PullJob(ctx, dockerops.PullInput{Image: c.str("image"), HostIDs: ids}, c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "prune_images":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		res, err := p.ops.PruneImages(ctx, r.ID)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Removed %d images on %s, reclaimed %s.", res.Count, r.Name, util.HumanBytes(int64(res.Reclaimed))), nil

	case "deploy_from_github":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		owner, repo, ok := strings.Cut(c.str("repo"), "/")
		if !ok || owner == "" || repo == "" {
			return "", uerr("repo must be \"owner/name\"")
		}
		cf := c.str("composeFile")
		if cf == "" {
			ins, err := p.git.Inspect(ctx, owner, repo, c.str("branch"), "", "")
			if err != nil {
				return "", err
			}
			if len(ins.ComposeFiles) == 0 {
				return "", uerr("no compose file found in %s/%s", owner, repo)
			}
			cf = ins.ComposeFiles[0]
		}
		id, err := p.git.Deploy(ctx, model.GitDeployInput{Owner: owner, Name: repo, Branch: c.str("branch"), ComposeFile: cf,
			HostID: r.ID, Path: c.str("path"), Env: []model.KV{}}, c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil

	case "run_container":
		r, err := p.host(ctx, c, c.str("host"))
		if err != nil {
			return "", err
		}
		in := model.RunContainerInput{HostID: r.ID, Image: c.str("image"), Name: c.str("name"), Restart: c.str("restart"), Env: []model.KV{}}
		if in.Restart == "" {
			in.Restart = "unless-stopped"
		}
		for _, ps := range c.strs("ports") {
			hp, cp, ok := strings.Cut(ps, ":")
			if !ok {
				cp, hp = hp, ""
			}
			in.Ports = append(in.Ports, struct {
				Host      string `json:"host"`
				Container string `json:"container"`
			}{hp, cp})
		}
		for _, vs := range c.strs("volumes") {
			src, dst, ok := strings.Cut(vs, ":")
			if !ok {
				return "", uerr("volume %q must be source:target", vs)
			}
			in.Volumes = append(in.Volumes, struct {
				Src string `json:"src"`
				Dst string `json:"dst"`
			}{src, dst})
		}
		if env, ok := c.args["env"].(map[string]any); ok {
			for k, v := range env {
				in.Env = append(in.Env, model.KV{K: k, V: fmt.Sprint(v)})
			}
		}
		id, err := p.ops.Run(ctx, in, c.actor)
		if err != nil {
			return "", err
		}
		return p.waitJob(ctx, id), nil
	}
	return "", uerr("tool %s is not implemented", name)
}

var errStop = errors.New("stop")
