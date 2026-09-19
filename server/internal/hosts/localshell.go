package hosts

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

// Host shell for the local connection method. There is no SSH session to the
// machine Dockhand runs on, so a short-lived privileged helper container joins
// the host's namespaces (PID 1) with nsenter and starts a login shell there —
// the same as `ssh root@host`. Dockhand already controls the Docker socket, so
// this grants nothing new; the helper is removed when the session ends.

const shellHelperImage = "alpine:3.22"

// Prefer bash, fall back to sh; start in root's home on the host.
const hostLoginShell = `cd ~ 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`

func (c *Conn) localShell(ctx context.Context, cols, rows int) (Terminal, error) {
	cli := c.Docker()
	if cli == nil {
		return nil, ErrNoShell
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if _, err := cli.ImageInspect(cctx, shellHelperImage); err != nil {
		rd, err := cli.ImagePull(cctx, shellHelperImage, image.PullOptions{})
		if err != nil {
			return nil, fmt.Errorf("pull %s for the host shell: %w", shellHelperImage, err)
		}
		_, _ = io.Copy(io.Discard, rd)
		rd.Close()
	}
	size := &[2]uint{uint(rows), uint(cols)}
	created, err := cli.ContainerCreate(cctx,
		&container.Config{
			Image: shellHelperImage, Tty: true, OpenStdin: true, StdinOnce: true,
			AttachStdin: true, AttachStdout: true, AttachStderr: true,
			Env:    []string{"TERM=xterm-256color", "HOME=/root"},
			Cmd:    []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-c", hostLoginShell},
			Labels: map[string]string{"dockhand.helper": "host-shell"},
		},
		&container.HostConfig{Privileged: true, PidMode: "host", AutoRemove: true, ConsoleSize: *size},
		nil, nil, "")
	if err != nil {
		return nil, fmt.Errorf("host shell: %w", err)
	}
	hj, err := cli.ContainerAttach(cctx, created.ID, container.AttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		_ = cli.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})
		return nil, fmt.Errorf("host shell attach: %w", err)
	}
	if err := cli.ContainerStart(cctx, created.ID, container.StartOptions{}); err != nil {
		hj.Close()
		_ = cli.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})
		return nil, fmt.Errorf("host shell start: %w", err)
	}
	activeShells.Store(created.ID, struct{}{})
	t := &helperTerm{cli: cli, id: created.ID, r: hj.Reader, w: hj.Conn, closer: hj.Conn}
	_ = t.Resize(cols, rows)
	return t, nil
}

type helperTerm struct {
	cli    *client.Client
	id     string
	r      io.Reader
	w      io.Writer
	closer io.Closer
}

func (t *helperTerm) Read(p []byte) (int, error)  { return t.r.Read(p) }
func (t *helperTerm) Write(p []byte) (int, error) { return t.w.Write(p) }

func (t *helperTerm) Resize(cols, rows int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return t.cli.ContainerResize(ctx, t.id, container.ResizeOptions{Height: uint(rows), Width: uint(cols)})
}

func (t *helperTerm) Wait() int {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	okC, errC := t.cli.ContainerWait(ctx, t.id, container.WaitConditionNotRunning)
	select {
	case r := <-okC:
		return int(r.StatusCode)
	case <-errC:
		return -1
	}
}

// Close ends the session and removes the helper (AutoRemove covers normal exits).
func (t *helperTerm) Close() error {
	err := t.closer.Close()
	activeShells.Delete(t.id)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = t.cli.ContainerRemove(ctx, t.id, container.RemoveOptions{Force: true})
	return err
}
