package dockerops

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"

	"dockhand/internal/hosts"
)

// LogLine is one log line.
type LogLine struct {
	T      time.Time `json:"t"`
	Stream string    `json:"stream"`
	Line   string    `json:"line"`
}

// LogOpts controls a log read.
type LogOpts struct {
	Tail   string // "200", "all"
	Since  string // "1h", RFC3339, unix
	Follow bool
}

// Logs streams a container's logs, calling emit per line until the stream
// ends or ctx is cancelled. Stdout/stderr are demultiplexed for non-TTY containers.
func (s *Service) Logs(ctx context.Context, hostID, ref string, o LogOpts, emit func(LogLine) error) error {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return err
	}
	cli := conn.Docker()
	ins, err := s.resolve(ctx, cli, hostID, ref)
	if err != nil {
		return err
	}
	if o.Tail == "" {
		o.Tail = "200"
	}
	if o.Tail != "all" {
		if n, err := strconv.Atoi(o.Tail); err != nil || n < 0 {
			return bad("tail must be a number or \"all\"")
		}
	}
	rd, err := cli.ContainerLogs(ctx, ins.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true, Follow: o.Follow,
		Tail: o.Tail, Since: o.Since, Timestamps: true})
	if err != nil {
		return wrap(err)
	}
	defer rd.Close()
	go func() { <-ctx.Done(); rd.Close() }()

	var mu sync.Mutex
	var emitErr error
	scan := func(r io.Reader, stream string, wg *sync.WaitGroup) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 2*1024*1024)
		for sc.Scan() {
			ll := parseLogLine(sc.Text(), stream)
			mu.Lock()
			if emitErr == nil {
				emitErr = emit(ll)
			}
			failed := emitErr != nil
			mu.Unlock()
			if failed {
				rd.Close()
				_, _ = io.Copy(io.Discard, r)
				return
			}
		}
		_, _ = io.Copy(io.Discard, r)
	}
	var wg sync.WaitGroup
	if ins.Config.Tty {
		wg.Add(1)
		scan(rd, "stdout", &wg)
	} else {
		so, sow := io.Pipe()
		se, sew := io.Pipe()
		wg.Add(2)
		go scan(so, "stdout", &wg)
		go scan(se, "stderr", &wg)
		_, err = stdcopy.StdCopy(sow, sew, rd)
		sow.Close()
		sew.Close()
		wg.Wait()
		if err != nil && ctx.Err() == nil && emitErr == nil && !errors.Is(err, io.ErrClosedPipe) {
			return err
		}
	}
	wg.Wait()
	return emitErr
}

// parseLogLine splits Docker's "<RFC3339Nano> <text>" timestamp prefix.
func parseLogLine(raw, stream string) LogLine {
	raw = strings.TrimRight(raw, "\r")
	if i := strings.IndexByte(raw, ' '); i > 0 {
		if t, err := time.Parse(time.RFC3339Nano, raw[:i]); err == nil {
			return LogLine{T: t, Stream: stream, Line: raw[i+1:]}
		}
	}
	return LogLine{T: time.Now().UTC(), Stream: stream, Line: raw}
}

// ─── Exec terminal ──────────────────────────────────────────────────────────

type execTerm struct {
	cli interface {
		ContainerExecResize(ctx context.Context, execID string, options container.ResizeOptions) error
		ContainerExecInspect(ctx context.Context, execID string) (container.ExecInspect, error)
	}
	id   string
	rw   io.ReadWriter
	conn io.Closer
}

func (t *execTerm) Read(p []byte) (int, error)  { return t.rw.Read(p) }
func (t *execTerm) Write(p []byte) (int, error) { return t.rw.Write(p) }
func (t *execTerm) Close() error                { return t.conn.Close() }
func (t *execTerm) Resize(cols, rows int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return t.cli.ContainerExecResize(ctx, t.id, container.ResizeOptions{Height: uint(rows), Width: uint(cols)})
}
func (t *execTerm) Wait() int {
	for i := 0; i < 20; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		ins, err := t.cli.ContainerExecInspect(ctx, t.id)
		cancel()
		if err != nil {
			return -1
		}
		if !ins.Running {
			return ins.ExitCode
		}
		time.Sleep(100 * time.Millisecond)
	}
	return -1
}

type hijackRW struct {
	r io.Reader
	w io.Writer
}

func (h hijackRW) Read(p []byte) (int, error)  { return h.r.Read(p) }
func (h hijackRW) Write(p []byte) (int, error) { return h.w.Write(p) }

// Exec starts an interactive TTY exec session in a container.
func (s *Service) Exec(ctx context.Context, hostID, ref, cmd string, cols, rows int) (hosts.Terminal, error) {
	conn, err := s.Conn(ctx, hostID)
	if err != nil {
		return nil, err
	}
	cli := conn.Docker()
	ins, err := s.resolve(ctx, cli, hostID, ref)
	if err != nil {
		return nil, err
	}
	if !ins.State.Running {
		return nil, bad("container %s is not running", strings.TrimPrefix(ins.Name, "/"))
	}
	argv := ShellArgv(cmd)
	size := &[2]uint{uint(rows), uint(cols)}
	ectx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ex, err := cli.ContainerExecCreate(ectx, ins.ID, container.ExecOptions{Tty: true, AttachStdin: true, AttachStdout: true,
		AttachStderr: true, Cmd: argv, ConsoleSize: size, Env: []string{"TERM=xterm-256color"}})
	if err != nil {
		return nil, fmt.Errorf("exec: %w", wrap(err))
	}
	hj, err := cli.ContainerExecAttach(ectx, ex.ID, container.ExecAttachOptions{Tty: true, ConsoleSize: size})
	if err != nil {
		return nil, fmt.Errorf("exec attach: %w", wrap(err))
	}
	return &execTerm{cli: cli, id: ex.ID, rw: hijackRW{r: hj.Reader, w: hj.Conn}, conn: hj.Conn}, nil
}

// autoShell starts the best interactive shell the image has: bash (completion,
// history, line editing), then ash/busybox sh, then plain sh.
const autoShell = `if command -v bash >/dev/null 2>&1; then exec bash; ` +
	`elif command -v ash >/dev/null 2>&1; then exec ash; ` +
	`elif command -v zsh >/dev/null 2>&1; then exec zsh; ` +
	`else exec sh; fi`

// ShellArgv turns the exec "cmd" parameter into argv. Empty, "auto" and the
// old default "/bin/sh" pick the best available shell.
func ShellArgv(cmd string) []string {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" || cmd == "auto" || cmd == "/bin/sh" || cmd == "sh" {
		return []string{"/bin/sh", "-c", autoShell}
	}
	return strings.Fields(cmd)
}
