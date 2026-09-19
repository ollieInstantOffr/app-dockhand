package hosts

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/pkg/stdcopy"
)

// HostExec runs a command on the machine's own operating system. Over SSH that
// is just Exec; for the local host (Docker socket, no SSH) it runs in a
// privileged helper container that enters the host's namespaces, the same way
// the local host shell does — so OS management works on both.
func (c *Conn) HostExec(ctx context.Context, cmd string) (ExecResult, error) {
	if !c.Local() {
		return c.Exec(ctx, cmd, nil)
	}
	cli := c.Docker()
	if cli == nil {
		return ExecResult{}, ErrNoShell
	}
	c.touch()
	if _, err := cli.ImageInspect(ctx, shellHelperImage); err != nil {
		rd, err := cli.ImagePull(ctx, shellHelperImage, image.PullOptions{})
		if err != nil {
			return ExecResult{}, fmt.Errorf("pull %s: %w", shellHelperImage, err)
		}
		_, _ = io.Copy(io.Discard, rd)
		rd.Close()
	}
	created, err := cli.ContainerCreate(ctx,
		&container.Config{
			Image:  shellHelperImage,
			Env:    []string{"HOME=/root", "LC_ALL=C", "DEBIAN_FRONTEND=noninteractive"},
			Cmd:    []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c", cmd},
			Labels: map[string]string{"dockhand.helper": "host-exec"},
		},
		&container.HostConfig{Privileged: true, PidMode: "host", AutoRemove: false}, nil, nil, "")
	if err != nil {
		return ExecResult{}, err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = cli.ContainerRemove(rctx, created.ID, container.RemoveOptions{Force: true})
	}()
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return ExecResult{}, err
	}
	waitC, errC := cli.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
	code := -1
	select {
	case w := <-waitC:
		code = int(w.StatusCode)
	case err := <-errC:
		return ExecResult{}, err
	case <-ctx.Done():
		return ExecResult{}, ctx.Err()
	}
	logs, err := cli.ContainerLogs(ctx, created.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return ExecResult{Code: code}, err
	}
	defer logs.Close()
	var out, errb bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &errb, logs); err != nil {
		return ExecResult{Code: code}, err
	}
	res := ExecResult{Stdout: out.String(), Stderr: errb.String(), Code: code}
	if code != 0 {
		return res, fmt.Errorf("command exited with status %d: %s", code, trimErr(res))
	}
	return res, nil
}

func trimErr(r ExecResult) string {
	msg := r.Stderr
	if msg == "" {
		msg = r.Stdout
	}
	if len(msg) > 600 {
		msg = msg[len(msg)-600:]
	}
	return msg
}

// HostExecStream runs a command on the machine's OS, streaming output lines.
// The local host runs it through the same privileged helper.
func (c *Conn) HostExecStream(ctx context.Context, cmd string, onLine func(stream, line string)) (int, error) {
	if !c.Local() {
		return c.ExecStream(ctx, cmd, nil, onLine)
	}
	res, err := c.HostExec(ctx, cmd)
	for _, l := range splitLines(res.Stdout) {
		onLine("stdout", l)
	}
	for _, l := range splitLines(res.Stderr) {
		onLine("stderr", l)
	}
	if err != nil && res.Code == 0 {
		return -1, err
	}
	return res.Code, nil
}

func splitLines(s string) []string {
	var out []string
	for _, l := range bytes.Split([]byte(s), []byte("\n")) {
		if t := string(bytes.TrimRight(l, "\r")); t != "" {
			out = append(out, t)
		}
	}
	return out
}
