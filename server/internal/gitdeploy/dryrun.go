package gitdeploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"dockhand/internal/dockerops"
	"dockhand/internal/model"
	"dockhand/internal/stacks"
)

const dryRunTimeout = 20 * time.Second

// DryRun renders the compose project a git deploy would start: it fetches the
// compose file (and .env.example) at the branch, writes them with a .env built
// from the request into a temp dir and runs `docker compose config` there.
// Nothing touches the host. Validation / compose errors come back as ok=false.
func (s *Service) DryRun(ctx context.Context, in model.GitDeployInput) (model.DryRunResult, error) {
	ctx, cancel := context.WithTimeout(ctx, dryRunTimeout)
	defer cancel()
	p, _, err := s.prepare(ctx, in, "")
	if err != nil {
		var br *dockerops.BadRequest
		if errors.As(err, &br) {
			return model.DryRunResult{OK: false, Command: "docker compose config", Output: br.Msg}, nil
		}
		return model.DryRunResult{}, err
	}
	row := stacks.Row{Name: p.name, Path: p.path, ComposeFile: p.composeFile}
	res := model.DryRunResult{Command: stacks.ComposeCmd(row, "config")}

	cl, err := s.Client(ctx, p.account)
	if err != nil {
		return res, err
	}
	content, err := cl.FileContent(ctx, p.owner, p.repo, p.composeFile, p.branch)
	if err != nil {
		return res, err
	}
	if content == nil {
		res.Output = fmt.Sprintf("%s was not found in %s/%s@%s", p.composeFile, p.owner, p.repo, p.branch)
		return res, nil
	}
	files := map[string][]byte{p.composeFile: content}
	for _, c := range envExampleCandidates(p.composeFile) {
		b, err := cl.FileContent(ctx, p.owner, p.repo, c, p.branch)
		if err == nil && b != nil {
			files[c] = b
			break
		}
	}
	envDir := path.Dir(p.composeFile)
	if len(p.env) > 0 {
		files[path.Join(envDir, ".env")] = []byte(envFile(p.env))
	}

	out, ok, err := ComposeConfig(ctx, p.name, p.composeFile, files, p.path)
	if err != nil {
		return res, err
	}
	res.OK, res.Output = ok, out
	return res, nil
}

// ComposeConfig writes files (repo-relative paths → content) into a temp dir,
// runs `docker compose -p name -f composeFile config` there and returns the
// rendered config (ok) or the error output, with the temp dir shown as
// displayRoot (the clone path on the host). The temp dir is removed afterwards.
// The command runs with a minimal environment so Dockhand's own variables
// never leak into the interpolation.
func ComposeConfig(ctx context.Context, name, composeFile string, files map[string][]byte, displayRoot string) (string, bool, error) {
	root, err := os.MkdirTemp("", "dockhand-dryrun-")
	if err != nil {
		return "", false, err
	}
	defer os.RemoveAll(root)
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r // macOS: /var → /private/var, as compose prints it
	}
	if displayRoot == "" {
		displayRoot = "."
	}
	for rel, b := range files {
		dst := filepath.Join(root, filepath.FromSlash(path.Clean("/" + rel))[1:])
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return "", false, err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return "", false, err
		}
	}
	cf := filepath.Join(root, filepath.FromSlash(composeFile))
	run := func(extra ...string) (string, string, error) {
		args := append([]string{"compose", "-p", name, "-f", cf, "config"}, extra...)
		cmd := exec.CommandContext(ctx, "docker", args...)
		cmd.Dir = root
		cmd.Env = minimalEnv()
		cmd.WaitDelay = 2 * time.Second
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		return stdout.String(), stderr.String(), err
	}
	clean := func(s string) string { return strings.ReplaceAll(s, root, displayRoot) }

	stdout, stderr, err := run()
	if err == nil {
		return clean(stdout), true, nil
	}
	if ctx.Err() != nil {
		return "", false, fmt.Errorf("docker compose config timed out: %w", ctx.Err())
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return "", false, fmt.Errorf("run docker compose: %w", err)
	}
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = strings.TrimSpace(stdout)
	}
	if !isInterpolationError(msg) {
		return clean(msg), false, nil
	}
	// Show the file without substitution so the user can still see the structure.
	raw, _, rerr := run("--no-interpolate")
	if rerr != nil {
		return clean(msg), false, nil
	}
	return clean(msg + "\n\n# Rendered without variable interpolation:\n" + raw), false, nil
}

// minimalEnv keeps only what the docker CLI needs to find the compose plugin.
func minimalEnv() []string {
	env := []string{}
	for _, k := range []string{"PATH", "HOME", "DOCKER_CONFIG"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

func isInterpolationError(msg string) bool {
	m := strings.ToLower(msg)
	return strings.Contains(m, "interpolat") || strings.Contains(m, "required variable") || strings.Contains(m, "invalid template")
}
