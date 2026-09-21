// Package dockerops implements container, image, volume and network
// operations against a host's Docker daemon.
package dockerops

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	"dockhand/internal/config"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/settings"
	"dockhand/internal/util"
)

// ErrNotFound is returned when a container/image/volume/network doesn't exist.
var ErrNotFound = errors.New("not found")

// BadRequest marks input validation errors.
type BadRequest struct{ Msg string }

func (e *BadRequest) Error() string { return e.Msg }

func bad(format string, a ...any) error { return &BadRequest{Msg: fmt.Sprintf(format, a...)} }

const opTimeout = 30 * time.Second

type Service struct {
	cfg      *config.Config
	hosts    *hosts.Store
	conns    *hosts.Manager
	mon      *monitor.Monitor
	jobs     *jobs.Runner
	settings *settings.Store

	disk diskCache
}

func New(cfg *config.Config, hs *hosts.Store, conns *hosts.Manager, mon *monitor.Monitor, jr *jobs.Runner, st *settings.Store) *Service {
	return &Service{cfg: cfg, hosts: hs, conns: conns, mon: mon, jobs: jr, settings: st}
}

// Conn returns a host connection with a bounded dial time.
func (s *Service) Conn(ctx context.Context, hostID string) (*hosts.Conn, error) {
	if _, err := s.hosts.Get(ctx, hostID); err != nil {
		return nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	c, err := s.conns.Get(dctx, hostID)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to host: %w", err)
	}
	return c, nil
}

func wrap(err error) error {
	if err == nil {
		return nil
	}
	if client.IsErrNotFound(err) {
		return fmt.Errorf("%w: %s", ErrNotFound, cleanDockerErr(err))
	}
	return errors.New(cleanDockerErr(err))
}

func cleanDockerErr(err error) string {
	msg := err.Error()
	msg = strings.TrimPrefix(msg, "Error response from daemon: ")
	return msg
}

// ─── Containers ─────────────────────────────────────────────────────────────

// Containers lists a host's containers, from the cache when available.
func (s *Service) Containers(ctx context.Context, hostID string) ([]model.Container, error) {
	if _, err := s.hosts.Get(ctx, hostID); err != nil {
		return nil, err
	}
	if !s.mon.HasCache(hostID) {
		s.mon.Refresh(ctx, hostID)
	}
	return s.mon.Containers(hostID), nil
}

// resolve finds the container id for an id / short id / name reference.
func (s *Service) resolve(ctx context.Context, cli *client.Client, hostID, ref string) (container.InspectResponse, error) {
	if c, ok := s.mon.Container(hostID, ref); ok {
		ref = c.ID
	}
	ictx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ins, err := cli.ContainerInspect(ictx, ref)
	if err != nil {
		return ins, wrap(err)
	}
	if ins.ContainerJSONBase == nil || ins.Config == nil || ins.State == nil {
		return ins, errors.New("incomplete inspect response from Docker")
	}
	return ins, nil
}

var secretNameRe = regexp.MustCompile(`(?i)(PASS(WORD|WD)?|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|SALT|SIGNING|_KEY$|^KEY$|DSN|CERT)`)
var urlCredRe = regexp.MustCompile(`^[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`)

// IsSecretEnv reports whether an environment variable looks like a secret.
func IsSecretEnv(k, v string) bool {
	if secretNameRe.MatchString(k) {
		// Common false positives.
		up := strings.ToUpper(k)
		if strings.HasSuffix(up, "_FILE") || strings.Contains(up, "PASSTHROUGH") || strings.HasSuffix(up, "KEYBOARD") || strings.Contains(up, "AUTHOR") && !strings.Contains(up, "AUTHORIZATION") {
			return false
		}
		return true
	}
	return urlCredRe.MatchString(v)
}

// Detail builds a ContainerDetail.
func (s *Service) Detail(ctx context.Context, hostID, ref string) (model.ContainerDetail, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return model.ContainerDetail{}, err
	}
	ins, err := s.resolve(ctx, conn.Docker(), hostID, ref)
	if err != nil {
		return model.ContainerDetail{}, err
	}
	d := model.ContainerDetail{Container: s.summaryFromInspect(hostID, ins)}
	if c, ok := s.mon.Container(hostID, ins.ID); ok {
		d.Container.CPU, d.Container.MemUsed, d.Container.MemLimit = c.CPU, c.MemUsed, c.MemLimit
		d.Container.Update = c.Update
		d.Container.Status = c.Status
	}
	cfg := ins.Config
	d.Command = strings.Join(cfg.Cmd, " ")
	d.Entrypoint = strings.Join(cfg.Entrypoint, " ")
	d.Workdir = cfg.WorkingDir
	d.Hostname = cfg.Hostname
	d.RestartCount = ins.RestartCount
	d.RestartPolicy = "no"
	if ins.HostConfig != nil && ins.HostConfig.RestartPolicy.Name != "" {
		d.RestartPolicy = string(ins.HostConfig.RestartPolicy.Name)
	}
	d.Env = []model.EnvVar{}
	for _, e := range cfg.Env {
		k, v, _ := strings.Cut(e, "=")
		d.Env = append(d.Env, model.EnvVar{K: k, V: v, Secret: IsSecretEnv(k, v)})
	}
	d.Labels = []model.KV{}
	keys := make([]string, 0, len(cfg.Labels))
	for k := range cfg.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		d.Labels = append(d.Labels, model.KV{K: k, V: cfg.Labels[k]})
	}
	d.Mounts = []model.Mount{}
	for _, m := range ins.Mounts {
		src := m.Source
		if m.Type == "volume" && m.Name != "" {
			src = m.Name
		}
		mode := "rw"
		if !m.RW {
			mode = "ro"
		}
		d.Mounts = append(d.Mounts, model.Mount{Type: string(m.Type), Src: src, Dst: m.Destination, Mode: mode})
	}
	d.Networks = []model.ContainerNetwork{}
	if ins.NetworkSettings != nil {
		names := make([]string, 0, len(ins.NetworkSettings.Networks))
		for n := range ins.NetworkSettings.Networks {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			ep := ins.NetworkSettings.Networks[n]
			driver := ""
			if n == "bridge" || n == "host" || n == "none" {
				driver = map[string]string{"bridge": "bridge", "host": "host", "none": "null"}[n]
			}
			d.Networks = append(d.Networks, model.ContainerNetwork{Name: n, IP: ep.IPAddress, GW: ep.Gateway, Driver: driver})
		}
		// Fill drivers for custom networks (best effort, cheap list call).
		if len(d.Networks) > 0 {
			lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if nets, err := conn.Docker().NetworkList(lctx, network.ListOptions{}); err == nil {
				drv := map[string]string{}
				for _, n := range nets {
					drv[n.Name] = n.Driver
				}
				for i := range d.Networks {
					if v, ok := drv[d.Networks[i].Name]; ok {
						d.Networks[i].Driver = v
					}
				}
			}
			cancel()
		}
	}
	if hc := cfg.Healthcheck; hc != nil && len(hc.Test) > 0 && hc.Test[0] != "NONE" {
		test := hc.Test
		if test[0] == "CMD" || test[0] == "CMD-SHELL" {
			test = test[1:]
		}
		d.HealthCmd = strings.Join(test, " ")
		iv := hc.Interval
		if iv == 0 {
			iv = 30 * time.Second
		}
		d.HealthInterval = iv.String()
	}
	d.History = s.mon.History(hostID, ins.ID)
	d.Events, err = s.mon.Events(ctx, hostID, d.Name, 50)
	if err != nil {
		d.Events = []model.ContainerEvent{}
	}
	return d, nil
}

func (s *Service) summaryFromInspect(hostID string, ins container.InspectResponse) model.Container {
	id := ins.ID
	short := id
	if len(short) > 12 {
		short = short[:12]
	}
	labels := ins.Config.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	created, _ := time.Parse(time.RFC3339Nano, ins.Created)
	c := model.Container{
		ID: id, ShortID: short, HostID: hostID, Name: strings.TrimPrefix(ins.Name, "/"), Image: ins.Config.Image, ImageID: ins.Image,
		State: string(ins.State.Status), Status: string(ins.State.Status), Health: "none", ExitCode: ins.State.ExitCode,
		Stack: labels["com.docker.compose.project"], Service: labels["com.docker.compose.service"], Ports: []model.PortMap{},
		CreatedAt: created, StartedAt: monitor.ParseDockerTime(ins.State.StartedAt), FinishedAt: monitor.ParseDockerTime(ins.State.FinishedAt),
		Update: model.UpdateInfo{Tag: monitor.ImageTag(ins.Config.Image)}, Labels: labels,
		WorkingDir: labels["com.docker.compose.project.working_dir"],
	}
	if ins.State.Running {
		c.FinishedAt = nil
	}
	if ins.State.Health != nil && ins.State.Health.Status != "" {
		c.Health = ins.State.Health.Status
	}
	if ins.NetworkSettings != nil {
		for port, binds := range ins.NetworkSettings.Ports {
			proto := port.Proto()
			if len(binds) == 0 {
				c.Ports = append(c.Ports, model.PortMap{Container: port.Int(), Proto: proto})
			}
			seen := map[string]bool{}
			for _, b := range binds {
				hp := 0
				fmt.Sscan(b.HostPort, &hp)
				key := fmt.Sprint(hp)
				if seen[key] {
					continue
				}
				seen[key] = true
				ip := b.HostIP
				if ip == "::" {
					ip = "0.0.0.0"
				}
				c.Ports = append(c.Ports, model.PortMap{IP: ip, Host: hp, Container: port.Int(), Proto: proto})
			}
		}
		sort.Slice(c.Ports, func(i, j int) bool { return c.Ports[i].Container < c.Ports[j].Container })
	}
	return c
}

// ContainerActions are the simple lifecycle actions.
var ContainerActions = map[string]bool{"start": true, "stop": true, "restart": true, "pause": true, "unpause": true, "kill": true}

// Action runs a lifecycle action and returns the refreshed container.
func (s *Service) Action(ctx context.Context, hostID, ref, action, actor string) (model.Container, error) {
	if !ContainerActions[action] {
		return model.Container{}, bad("unknown action %q", action)
	}
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return model.Container{}, err
	}
	cli := conn.Docker()
	ins, err := s.resolve(ctx, cli, hostID, ref)
	if err != nil {
		return model.Container{}, err
	}
	name := strings.TrimPrefix(ins.Name, "/")
	actx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	s.mon.RecordAction(ctx, hostID, name, action, actor)
	timeout := 10
	switch action {
	case "start":
		err = cli.ContainerStart(actx, ins.ID, container.StartOptions{})
	case "stop":
		err = cli.ContainerStop(actx, ins.ID, container.StopOptions{Timeout: &timeout})
	case "restart":
		err = cli.ContainerRestart(actx, ins.ID, container.StopOptions{Timeout: &timeout})
	case "pause":
		err = cli.ContainerPause(actx, ins.ID)
	case "unpause":
		err = cli.ContainerUnpause(actx, ins.ID)
	case "kill":
		err = cli.ContainerKill(actx, ins.ID, "KILL")
	}
	if err != nil {
		return model.Container{}, wrap(err)
	}
	s.mon.Refresh(ctx, hostID)
	if c, ok := s.mon.Container(hostID, ins.ID); ok {
		return c, nil
	}
	ins, err = s.resolve(ctx, cli, hostID, ins.ID)
	if err != nil {
		return model.Container{}, err
	}
	return s.summaryFromInspect(hostID, ins), nil
}

// BulkResult is the bulk action response.
type BulkResult struct {
	OK     []string     `json:"ok"`
	Failed []BulkFailed `json:"failed"`
}

type BulkFailed struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// Bulk runs an action on several containers.
func (s *Service) Bulk(ctx context.Context, hostID string, ids []string, action, actor string) BulkResult {
	res := BulkResult{OK: []string{}, Failed: []BulkFailed{}}
	for _, id := range ids {
		var err error
		switch {
		case action == "remove" || action == "delete":
			err = s.Remove(ctx, hostID, id, true, false, actor)
		case action == "update":
			_, err = s.UpdateContainer(hostID, id, actor)
		default:
			_, err = s.Action(ctx, hostID, id, action, actor)
		}
		if err != nil {
			res.Failed = append(res.Failed, BulkFailed{ID: id, Error: err.Error()})
		} else {
			res.OK = append(res.OK, id)
		}
	}
	return res
}

// Remove deletes a container.
func (s *Service) Remove(ctx context.Context, hostID, ref string, force, volumes bool, actor string) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	cli := conn.Docker()
	ins, err := s.resolve(ctx, cli, hostID, ref)
	if err != nil {
		return err
	}
	s.mon.RecordAction(ctx, hostID, strings.TrimPrefix(ins.Name, "/"), "remove", actor)
	rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := cli.ContainerRemove(rctx, ins.ID, container.RemoveOptions{Force: force, RemoveVolumes: volumes}); err != nil {
		return wrap(err)
	}
	s.mon.Refresh(ctx, hostID)
	return nil
}

// ─── Recreate / update ──────────────────────────────────────────────────────

// RecreateOpts tweaks the recreated container.
type RecreateOpts struct {
	Image         string   // new image ref ("" = same)
	Env           []string // nil = keep
	RestartPolicy string   // "" = keep
	Pull          bool
}

// Recreate replaces a container with a copy using opts. It renames the old
// container out of the way, starts the new one and removes the old one,
// rolling back on failure.
func (s *Service) Recreate(ctx context.Context, j *jobs.Job, conn *hosts.Conn, hostID string, ins container.InspectResponse, opts RecreateOpts) (string, error) {
	cli := conn.Docker()
	name := strings.TrimPrefix(ins.Name, "/")
	cfg := *ins.Config
	hc := *ins.HostConfig
	oldImage := cfg.Image
	if opts.Image != "" {
		cfg.Image = opts.Image
	}
	if opts.Pull {
		j.Step("Pulling image", cfg.Image)
		if err := s.Pull(ctx, conn, cfg.Image, j.Log); err != nil {
			return "", err
		}
		// Drop values that came from the old image so the new image's defaults apply.
		ictx, cancel := context.WithTimeout(ctx, 15*time.Second)
		oldImg, err := cli.ImageInspect(ictx, ins.Image)
		cancel()
		if err == nil && oldImg.Config != nil {
			cfg.Env = subtract(cfg.Env, oldImg.Config.Env)
			if equalStrings(cfg.Cmd, oldImg.Config.Cmd) {
				cfg.Cmd = nil
			}
			if equalStrings(cfg.Entrypoint, oldImg.Config.Entrypoint) {
				cfg.Entrypoint = nil
			}
			if cfg.WorkingDir == oldImg.Config.WorkingDir {
				cfg.WorkingDir = ""
			}
			if cfg.User == oldImg.Config.User {
				cfg.User = ""
			}
			for k, v := range oldImg.Config.Labels {
				if cfg.Labels[k] == v {
					delete(cfg.Labels, k)
				}
			}
			for p := range oldImg.Config.ExposedPorts {
				if _, bound := hc.PortBindings[nat.Port(p)]; !bound {
					delete(cfg.ExposedPorts, nat.Port(p))
				}
			}
			for v := range oldImg.Config.Volumes {
				delete(cfg.Volumes, v)
			}
			if cfg.Healthcheck != nil && oldImg.Config.Healthcheck != nil && equalStrings(cfg.Healthcheck.Test, oldImg.Config.Healthcheck.Test) {
				cfg.Healthcheck = nil
			}
		}
	}
	if opts.Env != nil {
		cfg.Env = opts.Env
	}
	if opts.RestartPolicy != "" {
		hc.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(opts.RestartPolicy)}
		if opts.RestartPolicy == "on-failure" {
			hc.RestartPolicy.MaximumRetryCount = 5
		}
	}
	// A hostname defaulted to the old container id must not stick.
	if len(ins.ID) >= 12 && cfg.Hostname == ins.ID[:12] {
		cfg.Hostname = ""
	}
	// Networking: first network at create time, the rest connected afterwards.
	var firstNet string
	var extra []string
	endpoints := map[string]*network.EndpointSettings{}
	if ins.NetworkSettings != nil {
		for n, ep := range ins.NetworkSettings.Networks {
			endpoints[n] = &network.EndpointSettings{IPAMConfig: ep.IPAMConfig, Links: ep.Links, Aliases: filterAliases(ep.Aliases, ins.ID), DriverOpts: ep.DriverOpts}
		}
	}
	mode := string(hc.NetworkMode)
	if _, ok := endpoints[mode]; ok {
		firstNet = mode
	}
	for n := range endpoints {
		if firstNet == "" && !strings.HasPrefix(mode, "container:") && mode != "host" && mode != "none" {
			firstNet = n
		}
		if n != firstNet {
			extra = append(extra, n)
		}
	}
	netCfg := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{}}
	if firstNet != "" {
		netCfg.EndpointsConfig[firstNet] = endpoints[firstNet]
	}

	j.Step("Recreating container", name)
	backup := fmt.Sprintf("%s-dockhand-old-%d", name, time.Now().Unix())
	wasRunning := ins.State.Running
	actor := j.Actor()
	s.mon.RecordAction(ctx, hostID, name, "recreate", actor)
	if err := cli.ContainerRename(ctx, ins.ID, backup); err != nil {
		return "", fmt.Errorf("rename old container: %w", wrap(err))
	}
	j.Logf("muted", "renamed %s → %s", name, backup)
	timeout := 20
	if wasRunning {
		if err := cli.ContainerStop(ctx, ins.ID, container.StopOptions{Timeout: &timeout}); err != nil {
			_ = cli.ContainerRename(context.Background(), ins.ID, name)
			return "", fmt.Errorf("stop old container: %w", wrap(err))
		}
		j.Log("muted", "stopped old container")
	}
	rollback := func(newID string, cause error) error {
		j.Log("warn", "rolling back: "+cause.Error())
		bg, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if newID != "" {
			_ = cli.ContainerRemove(bg, newID, container.RemoveOptions{Force: true})
		}
		_ = cli.ContainerRename(bg, ins.ID, name)
		if wasRunning {
			_ = cli.ContainerStart(bg, ins.ID, container.StartOptions{})
		}
		return cause
	}
	created, err := cli.ContainerCreate(ctx, &cfg, &hc, netCfg, nil, name)
	if err != nil {
		return "", rollback("", fmt.Errorf("create container: %w", wrap(err)))
	}
	for _, n := range extra {
		if err := cli.NetworkConnect(ctx, n, created.ID, endpoints[n]); err != nil {
			return "", rollback(created.ID, fmt.Errorf("connect network %s: %w", n, wrap(err)))
		}
	}
	for _, w := range created.Warnings {
		j.Log("warn", w)
	}
	j.Logf("info", "created %s (%s)", name, created.ID[:12])
	if wasRunning || opts.Image != "" || opts.Pull {
		j.Step("Starting container", name)
		if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
			return "", rollback(created.ID, fmt.Errorf("start container: %w", wrap(err)))
		}
		j.Log("ok", "started "+name)
	}
	j.Step("Removing old container", backup)
	if err := cli.ContainerRemove(ctx, ins.ID, container.RemoveOptions{Force: true}); err != nil {
		j.Log("warn", "could not remove old container: "+cleanDockerErr(err))
	}
	if oldImage != cfg.Image {
		j.Logf("muted", "image %s → %s", oldImage, cfg.Image)
	}
	s.mon.Refresh(context.Background(), hostID)
	return created.ID, nil
}

func filterAliases(a []string, id string) []string {
	out := []string{}
	for _, x := range a {
		if len(id) >= 12 && x == id[:12] {
			continue
		}
		out = append(out, x)
	}
	return out
}

func subtract(have, remove []string) []string {
	rm := map[string]bool{}
	for _, r := range remove {
		rm[r] = true
	}
	out := []string{}
	for _, h := range have {
		if !rm[h] {
			out = append(out, h)
		}
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// PatchInput is the PATCH container body.
type PatchInput struct {
	Env           []model.KV `json:"env"`
	RestartPolicy string     `json:"restartPolicy"`
}

// Patch recreates a container with new env / restart policy (job).
func (s *Service) Patch(ctx context.Context, hostID, ref string, in PatchInput, actor string) (string, error) {
	switch in.RestartPolicy {
	case "", "no", "always", "unless-stopped", "on-failure":
	default:
		return "", bad("restartPolicy must be no, always, unless-stopped or on-failure")
	}
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return "", err
	}
	ins, err := s.resolve(ctx, conn.Docker(), hostID, ref)
	if err != nil {
		return "", err
	}
	var env []string
	if in.Env != nil {
		env = []string{}
		for _, kv := range in.Env {
			k := strings.TrimSpace(kv.K)
			if k == "" {
				continue
			}
			if strings.ContainsAny(k, "= \t\n") {
				return "", bad("invalid environment variable name %q", k)
			}
			env = append(env, k+"="+kv.V)
		}
	}
	name := strings.TrimPrefix(ins.Name, "/")
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: "Reconfigure " + name, HostID: hostID, Actor: actor,
		Plan: []string{"Recreating container", "Starting container", "Removing old container"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			id, err := s.Recreate(ctx, j, conn, hostID, ins, RecreateOpts{Env: env, RestartPolicy: in.RestartPolicy})
			if err != nil {
				return err
			}
			j.Set("containerId", id)
			return nil
		})
}

// UpdateContainer pulls the newest image for a container's tag and recreates it (job).
func (s *Service) UpdateContainer(hostID, ref, actor string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return "", err
	}
	ins, err := s.resolve(ctx, conn.Docker(), hostID, ref)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(ins.Name, "/")
	project := ins.Config.Labels["com.docker.compose.project"]
	if project != "" {
		return s.jobs.Start(jobs.Spec{Kind: "update", Title: "Update " + name, HostID: hostID, Actor: actor,
			Plan: []string{"Pulling image", "Recreating service"}},
			func(ctx context.Context, j *jobs.Job) error {
				return s.updateComposeService(ctx, j, hostID, ins)
			})
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: "Update " + name, HostID: hostID, Actor: actor,
		Plan: []string{"Pulling image", "Recreating container", "Starting container", "Removing old container"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			id, err := s.Recreate(ctx, j, conn, hostID, ins, RecreateOpts{Pull: true})
			if err != nil {
				return err
			}
			s.mon.ClearUpdate(hostID, ins.Config.Image)
			j.Set("containerId", id)
			return nil
		})
}

func (s *Service) updateComposeService(ctx context.Context, j *jobs.Job, hostID string, ins container.InspectResponse) error {
	conn, err := s.conns.Get(ctx, hostID)
	if err != nil {
		return err
	}
	l := ins.Config.Labels
	project, service, wd := l["com.docker.compose.project"], l["com.docker.compose.service"], l["com.docker.compose.project.working_dir"]
	files := ComposeFileArgs(l["com.docker.compose.project.config_files"])
	base := "docker compose -p " + util.Shq(project) + files
	cd := ""
	if wd != "" {
		cd = "cd " + util.Shq(wd) + " && "
	}
	j.Step("Pulling image", ins.Config.Image)
	if err := RunLogged(ctx, conn, j, cd+base+" pull "+util.Shq(service)); err != nil {
		return err
	}
	j.Step("Recreating service", service)
	s.mon.RecordAction(ctx, hostID, strings.TrimPrefix(ins.Name, "/"), "update", j.Actor())
	if err := RunLogged(ctx, conn, j, cd+base+" up -d "+util.Shq(service)); err != nil {
		return err
	}
	s.mon.ClearUpdate(hostID, ins.Config.Image)
	s.mon.Refresh(context.Background(), hostID)
	return nil
}

// ComposeFileArgs renders " -f a -f b" from the config_files label.
func ComposeFileArgs(label string) string {
	out := ""
	for _, f := range strings.Split(label, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out += " -f " + util.Shq(f)
		}
	}
	return out
}

// RunLogged runs a command on the host streaming output into the job log.
func RunLogged(ctx context.Context, conn *hosts.Conn, j *jobs.Job, cmd string) error {
	j.Log("cmd", "$ "+cmd)
	if strings.Contains(cmd, "docker compose") || strings.Contains(cmd, "docker pull") || strings.Contains(cmd, "docker build") {
		wrapped, cleanup, err := withRegistryConfig(ctx, conn, cmd)
		if err != nil {
			j.Logf("warn", "couldn't pass saved registry credentials to the host: %v", err)
		} else {
			defer cleanup()
			cmd = wrapped
		}
	}
	var last []string
	code, err := conn.ExecStream(ctx, cmd, nil, func(stream, line string) {
		if strings.TrimSpace(line) == "" {
			return
		}
		level := "info"
		if stream == "stderr" {
			level = "muted"
			l := strings.ToLower(line)
			// Tools log structured lines like `level=warning msg="…" error="…"`; the level wins.
			if strings.Contains(l, "level=warn") || strings.HasPrefix(l, "warn") || strings.HasPrefix(l, "warning") {
				level = "warn"
			} else if strings.Contains(l, "error") || strings.Contains(l, "failed") {
				level = "error"
			} else if strings.Contains(l, "warn") {
				level = "warn"
			}
		}
		j.Log(level, line)
		last = append(last, line)
		if len(last) > 3 {
			last = last[1:]
		}
	})
	if err != nil {
		return err
	}
	if code != 0 {
		msg := fmt.Sprintf("command exited with status %d", code)
		if len(last) > 0 {
			msg += ": " + last[len(last)-1]
		}
		return errors.New(msg)
	}
	return nil
}

// UpdateAll updates every container with an image update available (job).
func (s *Service) UpdateAll(ctx context.Context, hostID, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	targets := []model.Container{}
	for _, c := range s.mon.Containers(hostID) {
		if c.Update.Available {
			targets = append(targets, c)
		}
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: fmt.Sprintf("Update all on %s", rec.Name), HostID: hostID, Actor: actor},
		func(ctx context.Context, j *jobs.Job) error {
			if len(targets) == 0 {
				j.Step("Checking for updates", "")
				j.Log("info", "no containers have image updates available")
				return nil
			}
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			failed := 0
			doneProjects := map[string]bool{}
			for _, c := range targets {
				ins, err := s.resolve(ctx, conn.Docker(), hostID, c.ID)
				if err != nil {
					j.Logf("error", "%s: %v", c.Name, err)
					failed++
					continue
				}
				j.Logf("info", "── updating %s (%s)", c.Name, c.Image)
				if p := ins.Config.Labels["com.docker.compose.project"]; p != "" {
					key := p + "/" + ins.Config.Labels["com.docker.compose.service"]
					if doneProjects[key] {
						continue
					}
					doneProjects[key] = true
					err = s.updateComposeService(ctx, j, hostID, ins)
				} else {
					_, err = s.Recreate(ctx, j, conn, hostID, ins, RecreateOpts{Pull: true})
					if err == nil {
						s.mon.ClearUpdate(hostID, ins.Config.Image)
					}
				}
				if err != nil {
					j.Logf("error", "%s: %v", c.Name, err)
					failed++
				}
			}
			j.Set("updated", len(targets)-failed)
			if failed > 0 {
				return fmt.Errorf("%d of %d updates failed", failed, len(targets))
			}
			return nil
		})
}

// ─── Run ────────────────────────────────────────────────────────────────────

var containerNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// RunSpec is everything ContainerCreate receives for a "run" request.
type RunSpec struct {
	Name             string
	Config           *container.Config
	HostConfig       *container.HostConfig
	NetworkingConfig *network.NetworkingConfig
}

// BuildRunSpec validates a run request and builds the container configuration
// (pure: shared by Run and the dry-run so the preview can't drift).
// domain is the settings' general.domain used for traefik labels.
func BuildRunSpec(in model.RunContainerInput, domain string) (RunSpec, error) {
	in.Image = strings.TrimSpace(in.Image)
	in.Name = strings.TrimSpace(in.Name)
	if in.Image == "" {
		return RunSpec{}, bad("image is required")
	}
	if in.Name != "" && !containerNameRe.MatchString(in.Name) {
		return RunSpec{}, bad("invalid container name %q", in.Name)
	}
	cfg := &container.Config{Image: in.Image, Labels: map[string]string{"dockhand.managed": "true"}, ExposedPorts: nat.PortSet{}}
	hc := &container.HostConfig{PortBindings: nat.PortMap{}}
	switch in.Restart {
	case "", "no":
	case "always", "unless-stopped", "on-failure":
		hc.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(in.Restart)}
	default:
		return RunSpec{}, bad("restart must be no, always, unless-stopped or on-failure")
	}
	for _, p := range in.Ports {
		cp := strings.TrimSpace(p.Container)
		if cp == "" {
			continue
		}
		proto := "tcp"
		if a, b, ok := strings.Cut(cp, "/"); ok {
			cp, proto = a, b
		}
		port, err := nat.NewPort(proto, cp)
		if err != nil {
			return RunSpec{}, bad("invalid container port %q", p.Container)
		}
		cfg.ExposedPorts[port] = struct{}{}
		hp := strings.TrimSpace(p.Host)
		hostIP := ""
		if i := strings.LastIndex(hp, ":"); i >= 0 {
			hostIP, hp = hp[:i], hp[i+1:]
		}
		if hp != "" {
			hc.PortBindings[port] = append(hc.PortBindings[port], nat.PortBinding{HostIP: hostIP, HostPort: hp})
		}
	}
	for _, v := range in.Volumes {
		src, dst := strings.TrimSpace(v.Src), strings.TrimSpace(v.Dst)
		if src == "" || dst == "" {
			continue
		}
		if !strings.HasPrefix(dst, "/") {
			return RunSpec{}, bad("volume target %q must be an absolute path", dst)
		}
		hc.Binds = append(hc.Binds, src+":"+dst)
	}
	for _, kv := range in.Env {
		if k := strings.TrimSpace(kv.K); k != "" {
			cfg.Env = append(cfg.Env, k+"="+kv.V)
		}
	}
	netName := strings.TrimSpace(in.Network)
	if netName != "" && netName != "bridge" && netName != "default" {
		hc.NetworkMode = container.NetworkMode(netName)
	}
	if in.Traefik {
		name := in.Name
		if name == "" {
			return RunSpec{}, bad("a container name is required for traefik labels")
		}
		cfg.Labels["traefik.enable"] = "true"
		cfg.Labels["traefik.http.routers."+name+".rule"] = "Host(`" + name + "." + domain + "`)"
	}
	return RunSpec{Name: in.Name, Config: cfg, HostConfig: hc}, nil
}

// Run pulls, creates and starts a new container (job).
func (s *Service) Run(ctx context.Context, in model.RunContainerInput, actor string) (string, error) {
	spec, err := BuildRunSpec(in, s.settings.Get().General.Domain)
	if err != nil {
		return "", err
	}
	in.Image, in.Name = spec.Config.Image, spec.Name
	rec, err := s.hosts.Get(ctx, in.HostID)
	if err != nil {
		return "", err
	}
	cfg, hc := spec.Config, spec.HostConfig
	title := "Run " + in.Image
	if in.Name != "" {
		title = "Run " + in.Name
	}
	return s.jobs.Start(jobs.Spec{Kind: "image", Title: title, HostID: rec.ID, Actor: actor,
		Plan: []string{"Pulling image", "Creating container", "Starting container"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, rec.ID)
			if err != nil {
				return err
			}
			cli := conn.Docker()
			j.Step("Pulling image", in.Image)
			if err := s.Pull(ctx, conn, in.Image, j.Log); err != nil {
				return err
			}
			j.Step("Creating container", in.Name)
			created, err := cli.ContainerCreate(ctx, cfg, hc, spec.NetworkingConfig, nil, in.Name)
			if err != nil {
				return wrap(err)
			}
			for _, w := range created.Warnings {
				j.Log("warn", w)
			}
			j.Set("containerId", created.ID)
			name := in.Name
			if name == "" {
				if ins, err := cli.ContainerInspect(ctx, created.ID); err == nil && ins.ContainerJSONBase != nil {
					name = strings.TrimPrefix(ins.Name, "/")
				}
			}
			j.Set("name", name)
			j.Step("Starting container", name)
			s.mon.RecordAction(ctx, rec.ID, name, "create", actor)
			if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
				return wrap(err)
			}
			j.Logf("ok", "%s is running (%s)", name, created.ID[:12])
			s.mon.Refresh(context.Background(), rec.ID)
			return nil
		})
}

// Reboot runs `sudo -n reboot` on a host.
func (s *Service) Reboot(ctx context.Context, hostID string) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	if conn.Local() {
		return bad("rebooting isn't supported for the local connection method")
	}
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = conn.Exec(rctx, "sudo -n reboot || sudo -n shutdown -r now || reboot", nil)
	// The connection usually drops mid-command; that counts as success.
	if err != nil && !strings.Contains(err.Error(), "without an exit status") && !strings.Contains(err.Error(), "EOF") &&
		!strings.Contains(err.Error(), "timed out") {
		return fmt.Errorf("reboot failed (does %s have passwordless sudo?): %w", "the SSH user", err)
	}
	slog.Info("host reboot requested", "host", hostID)
	s.conns.Invalidate(hostID)
	return nil
}
