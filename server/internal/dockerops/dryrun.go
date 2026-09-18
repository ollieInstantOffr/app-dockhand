package dockerops

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/docker/go-connections/nat"

	"dockhand/internal/model"
	"dockhand/internal/util"
)

// RunDryRun builds the configuration POST /api/containers/run would create,
// without touching the host. Validation errors are returned as ok=false.
func (s *Service) RunDryRun(ctx context.Context, in model.RunContainerInput) (model.DryRunResult, error) {
	if _, err := s.hosts.Get(ctx, in.HostID); err != nil {
		return model.DryRunResult{}, err
	}
	spec, err := BuildRunSpec(in, s.settings.Get().General.Domain)
	if err != nil {
		var br *BadRequest
		if errors.As(err, &br) {
			return model.DryRunResult{OK: false, Command: "docker run", Output: br.Msg}, nil
		}
		return model.DryRunResult{}, err
	}
	b, err := json.MarshalIndent(map[string]any{
		"config":           spec.Config,
		"hostConfig":       spec.HostConfig,
		"networkingConfig": spec.NetworkingConfig,
	}, "", "  ")
	if err != nil {
		return model.DryRunResult{}, err
	}
	return model.DryRunResult{OK: true, Command: DockerRunCommand(spec), Output: string(b)}, nil
}

// DockerRunCommand renders a RunSpec as the equivalent `docker run` line.
func DockerRunCommand(spec RunSpec) string {
	cfg, hc := spec.Config, spec.HostConfig
	args := []string{"docker", "run", "-d"}
	if spec.Name != "" {
		args = append(args, "--name", spec.Name)
	}
	if hc != nil && hc.RestartPolicy.Name != "" && hc.RestartPolicy.Name != "no" {
		args = append(args, "--restart", string(hc.RestartPolicy.Name))
	}
	if hc != nil && hc.NetworkMode != "" {
		args = append(args, "--network", string(hc.NetworkMode))
	}
	// Ports: published bindings as -p, the rest as --expose.
	ports := make([]string, 0, len(cfg.ExposedPorts))
	for p := range cfg.ExposedPorts {
		ports = append(ports, string(p))
	}
	sort.Slice(ports, func(i, j int) bool {
		a, b := nat.Port(ports[i]), nat.Port(ports[j])
		if a.Int() != b.Int() {
			return a.Int() < b.Int()
		}
		return a.Proto() < b.Proto()
	})
	for _, ps := range ports {
		p := nat.Port(ps)
		ctr := p.Port()
		if p.Proto() != "tcp" {
			ctr += "/" + p.Proto()
		}
		var binds []nat.PortBinding
		if hc != nil {
			binds = hc.PortBindings[p]
		}
		if len(binds) == 0 {
			args = append(args, "--expose", ctr)
			continue
		}
		for _, b := range binds {
			host := b.HostPort
			if b.HostIP != "" {
				host = b.HostIP + ":" + host
			}
			args = append(args, "-p", host+":"+ctr)
		}
	}
	if hc != nil {
		for _, v := range hc.Binds {
			args = append(args, "-v", v)
		}
	}
	for _, e := range cfg.Env {
		args = append(args, "-e", e)
	}
	labels := make([]string, 0, len(cfg.Labels))
	for k := range cfg.Labels {
		labels = append(labels, k)
	}
	sort.Strings(labels)
	for _, k := range labels {
		args = append(args, "--label", k+"="+cfg.Labels[k])
	}
	args = append(args, cfg.Image)
	for i, a := range args {
		args[i] = shellArg(a)
	}
	return strings.Join(args, " ")
}

// shellArg quotes a word only when the shell would otherwise mangle it.
func shellArg(s string) string {
	if s == "" {
		return "''"
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:=@,+%", r)) {
			return util.Shq(s)
		}
	}
	return s
}
