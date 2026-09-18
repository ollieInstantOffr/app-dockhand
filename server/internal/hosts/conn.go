package hosts

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/client"
	"golang.org/x/crypto/ssh"

	"dockhand/internal/secret"
)

const (
	dialTimeout = 10 * time.Second
	idleTimeout = 10 * time.Minute
	remoteSock  = "/var/run/docker.sock"
)

// ErrNoShell is returned for host shells on local hosts.
var ErrNoShell = errors.New("a host shell isn't available for the local connection method — open a container terminal instead")

// Target is everything needed to connect to a host.
type Target struct {
	ID       string
	Name     string
	Address  string
	Port     int
	User     string
	Method   string
	Password string
	HostKey  string // pinned authorized_keys line, "" = trust on first use
}

// DialInfo describes a successful SSH handshake.
type DialInfo struct {
	RemoteIP      string
	ServerVersion string
	HostKey       string // authorized_keys format
	Fingerprint   string
	ResolveMs     int64
	ConnectMs     int64
	AuthMs        int64
}

// Conn is a live connection to a host.
type Conn struct {
	target Target
	ssh    *ssh.Client
	docker *client.Client

	mu       sync.Mutex
	lastUsed time.Time
	closed   bool
}

func (c *Conn) touch() {
	c.mu.Lock()
	c.lastUsed = time.Now()
	c.mu.Unlock()
}

// Local reports whether this host uses the local socket.
func (c *Conn) Local() bool { return c.target.Method == "local" }

// Docker returns the Docker API client.
func (c *Conn) Docker() *client.Client { c.touch(); return c.docker }

// HostID returns the host id.
func (c *Conn) HostID() string { return c.target.ID }

// Name returns the host name.
func (c *Conn) Name() string { return c.target.Name }

// Close tears down the connection.
func (c *Conn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	if c.docker != nil {
		_ = c.docker.Close()
	}
	if c.ssh != nil {
		_ = c.ssh.Close()
	}
}

// ExecResult is the output of a command.
type ExecResult struct {
	Stdout, Stderr string
	Code           int
}

// Exec runs a shell command on the host and returns its output. A non-zero
// exit status is returned as an error that includes stderr.
func (c *Conn) Exec(ctx context.Context, cmd string, stdin io.Reader) (ExecResult, error) {
	var out, errb bytes.Buffer
	code, err := c.run(ctx, cmd, stdin, &out, &errb)
	res := ExecResult{Stdout: out.String(), Stderr: errb.String(), Code: code}
	if err != nil {
		return res, err
	}
	if code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = strings.TrimSpace(res.Stdout)
		}
		if len(msg) > 600 {
			msg = msg[len(msg)-600:]
		}
		return res, fmt.Errorf("command exited with status %d: %s", code, msg)
	}
	return res, nil
}

// ExecStream runs a command and calls onLine for every stdout/stderr line.
func (c *Conn) ExecStream(ctx context.Context, cmd string, stdin io.Reader, onLine func(stream, line string)) (int, error) {
	var wg sync.WaitGroup
	var lineMu sync.Mutex
	mk := func(stream string) io.WriteCloser {
		pr, pw := io.Pipe()
		wg.Add(1)
		go func() {
			defer wg.Done()
			sc := bufio.NewScanner(pr)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			sc.Split(scanLinesCR)
			for sc.Scan() {
				lineMu.Lock()
				onLine(stream, sc.Text())
				lineMu.Unlock()
			}
			_, _ = io.Copy(io.Discard, pr)
		}()
		return pw
	}
	so, se := mk("stdout"), mk("stderr")
	code, err := c.run(ctx, cmd, stdin, so, se)
	so.Close()
	se.Close()
	wg.Wait()
	return code, err
}

// scanLinesCR splits on \n or \r so progress output renders line by line.
func scanLinesCR(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		j := i + 1
		if data[i] == '\r' && j < len(data) && data[j] == '\n' {
			j++
		}
		return j, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func (c *Conn) run(ctx context.Context, cmd string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	c.touch()
	if c.Local() {
		ec := exec.CommandContext(ctx, "sh", "-c", cmd)
		ec.Stdin, ec.Stdout, ec.Stderr = stdin, stdout, stderr
		ec.WaitDelay = 2 * time.Second
		err := ec.Run()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		if err != nil {
			return -1, err
		}
		return 0, nil
	}
	sess, err := c.ssh.NewSession()
	if err != nil {
		return -1, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	sess.Stdin, sess.Stdout, sess.Stderr = stdin, stdout, stderr
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = sess.Signal(ssh.SIGKILL)
			_ = sess.Close()
		case <-done:
		}
	}()
	err = sess.Run(cmd)
	if ctx.Err() != nil {
		return -1, fmt.Errorf("command timed out or was cancelled: %w", ctx.Err())
	}
	var ee *ssh.ExitError
	if errors.As(err, &ee) {
		return ee.ExitStatus(), nil
	}
	var em *ssh.ExitMissingError
	if errors.As(err, &em) {
		return -1, errors.New("remote command ended without an exit status")
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// Terminal is an interactive PTY session.
type Terminal interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Wait() int
	Close() error
}

type sshTerm struct {
	sess   *ssh.Session
	stdin  io.WriteCloser
	output io.Reader
	done   chan struct{}
	code   int
}

func (t *sshTerm) Read(p []byte) (int, error)  { return t.output.Read(p) }
func (t *sshTerm) Write(p []byte) (int, error) { return t.stdin.Write(p) }
func (t *sshTerm) Resize(cols, rows int) error { return t.sess.WindowChange(rows, cols) }
func (t *sshTerm) Close() error                { return t.sess.Close() }
func (t *sshTerm) Wait() int                   { <-t.done; return t.code }

// Shell opens an interactive login shell with a PTY.
func (c *Conn) Shell(ctx context.Context, cols, rows int) (Terminal, error) {
	if c.Local() {
		return nil, ErrNoShell
	}
	c.touch()
	sess, err := c.ssh.NewSession()
	if err != nil {
		return nil, err
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		return nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	pr, pw := io.Pipe()
	sess.Stdout, sess.Stderr = pw, pw
	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, err
	}
	t := &sshTerm{sess: sess, stdin: stdin, output: pr, done: make(chan struct{})}
	go func() {
		err := sess.Wait()
		var ee *ssh.ExitError
		switch {
		case errors.As(err, &ee):
			t.code = ee.ExitStatus()
		case err != nil:
			t.code = -1
		}
		pw.Close()
		close(t.done)
	}()
	return t, nil
}

// ─── Manager ────────────────────────────────────────────────────────────────

// Manager lazily dials and caches connections per host id.
type Manager struct {
	store  *Store
	box    *secret.Box
	signer ssh.Signer

	mu    sync.Mutex
	conns map[string]*Conn
	dials map[string]*dialCall
}

type dialCall struct {
	done chan struct{}
	conn *Conn
	err  error
}

func NewManager(store *Store, box *secret.Box, signer ssh.Signer) *Manager {
	return &Manager{store: store, box: box, signer: signer, conns: map[string]*Conn{}, dials: map[string]*dialCall{}}
}

// Target builds a dial target for a host record.
func (m *Manager) Target(r Record) (Target, error) {
	pw, err := m.box.Decrypt(r.PasswordEnc)
	if err != nil {
		return Target{}, err
	}
	return Target{ID: r.ID, Name: r.Name, Address: r.Address, Port: r.Port, User: r.User, Method: r.Method, Password: pw, HostKey: r.HostKey}, nil
}

// Get returns a cached connection or dials a new one. Concurrent callers share one dial.
func (m *Manager) Get(ctx context.Context, hostID string) (*Conn, error) {
	m.mu.Lock()
	if c, ok := m.conns[hostID]; ok {
		m.mu.Unlock()
		if c.alive() {
			c.touch()
			return c, nil
		}
		m.Invalidate(hostID)
		m.mu.Lock()
	}
	if d, ok := m.dials[hostID]; ok {
		m.mu.Unlock()
		select {
		case <-d.done:
			return d.conn, d.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	d := &dialCall{done: make(chan struct{})}
	m.dials[hostID] = d
	m.mu.Unlock()

	go func() {
		dctx, cancel := context.WithTimeout(context.Background(), 2*dialTimeout)
		defer cancel()
		d.conn, d.err = m.dial(dctx, hostID)
		m.mu.Lock()
		delete(m.dials, hostID)
		if d.err == nil {
			m.conns[hostID] = d.conn
		}
		m.mu.Unlock()
		close(d.done)
	}()
	select {
	case <-d.done:
		return d.conn, d.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *Manager) dial(ctx context.Context, hostID string) (*Conn, error) {
	rec, err := m.store.Get(ctx, hostID)
	if err != nil {
		return nil, err
	}
	t, err := m.Target(rec)
	if err != nil {
		return nil, err
	}
	c, info, err := m.Connect(ctx, t)
	if err != nil {
		return nil, err
	}
	if t.HostKey == "" && info.HostKey != "" {
		if err := m.store.PinHostKey(ctx, t.ID, info.HostKey); err != nil {
			slog.Warn("pin host key", "host", t.Name, "err", err)
		}
	}
	return c, nil
}

// Invalidate closes and forgets a host's connection.
func (m *Manager) Invalidate(hostID string) {
	m.mu.Lock()
	c := m.conns[hostID]
	delete(m.conns, hostID)
	m.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

// CloseIdle closes connections unused for longer than the idle timeout.
func (m *Manager) CloseIdle() {
	m.mu.Lock()
	var stale []*Conn
	for id, c := range m.conns {
		c.mu.Lock()
		idle := time.Since(c.lastUsed) > idleTimeout
		c.mu.Unlock()
		if idle {
			stale = append(stale, c)
			delete(m.conns, id)
		}
	}
	m.mu.Unlock()
	for _, c := range stale {
		c.Close()
	}
}

// CloseAll closes every connection.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := m.conns
	m.conns = map[string]*Conn{}
	m.mu.Unlock()
	for _, c := range all {
		c.Close()
	}
}

func (c *Conn) alive() bool {
	c.mu.Lock()
	closed, last := c.closed, c.lastUsed
	c.mu.Unlock()
	if closed {
		return false
	}
	if c.ssh == nil || time.Since(last) < 30*time.Second {
		return true
	}
	res := make(chan error, 1)
	go func() {
		_, _, err := c.ssh.SendRequest("keepalive@openssh.com", true, nil)
		res <- err
	}()
	select {
	case err := <-res:
		return err == nil
	case <-time.After(5 * time.Second):
		return false
	}
}

// ErrHostKeyMismatch is returned when the server presents a different key than the pinned one.
type ErrHostKeyMismatch struct{ Expected, Got string }

func (e *ErrHostKeyMismatch) Error() string {
	return fmt.Sprintf("host key mismatch: expected %s but the server presented %s — if the host was reinstalled, reset the pinned key in the host settings", e.Expected, e.Got)
}

// Connect dials a target without caching it (used by the host test and by Get).
func (m *Manager) Connect(ctx context.Context, t Target) (*Conn, DialInfo, error) {
	info, sshc, err := m.DialSSH(ctx, t, nil)
	if err != nil {
		return nil, info, err
	}
	c := &Conn{target: t, ssh: sshc, lastUsed: time.Now()}
	dc, err := newDockerClient(t, sshc)
	if err != nil {
		c.Close()
		return nil, info, err
	}
	c.docker = dc
	return c, info, nil
}

// StepFunc reports progress of the SSH dial phases ("resolve", "connect", "auth").
type StepFunc func(phase string, ms int64, sub string, err error)

// DialSSH resolves, connects and authenticates. For local targets it returns a nil client.
func (m *Manager) DialSSH(ctx context.Context, t Target, step StepFunc) (DialInfo, *ssh.Client, error) {
	var info DialInfo
	if t.Method == "local" {
		return info, nil, nil
	}
	report := func(phase string, start time.Time, sub string, err error) int64 {
		ms := time.Since(start).Milliseconds()
		if step != nil {
			step(phase, ms, sub, err)
		}
		return ms
	}
	start := time.Now()
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ips, err := net.DefaultResolver.LookupIPAddr(rctx, t.Address)
	cancel()
	if err != nil || len(ips) == 0 {
		if err == nil {
			err = errors.New("no addresses")
		}
		err = fmt.Errorf("cannot resolve %s: %w", t.Address, err)
		report("resolve", start, "", err)
		return info, nil, err
	}
	ip := ips[0].IP.String()
	for _, a := range ips {
		if a.IP.To4() != nil {
			ip = a.IP.String()
			break
		}
	}
	info.RemoteIP = ip
	addr := net.JoinHostPort(ip, fmt.Sprint(t.Port))
	// Quick reachability probe for the resolve step's sub text.
	info.ResolveMs = report("resolve", start, fmt.Sprintf("%s → %d/tcp", ip, t.Port), nil)

	start = time.Now()
	d := net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	raw, err := d.DialContext(dctx, "tcp", addr)
	cancel()
	if err != nil {
		err = fmt.Errorf("cannot reach %s: %w", addr, err)
		report("connect", start, "", err)
		return info, nil, err
	}
	_ = raw.SetDeadline(time.Now().Add(dialTimeout))
	// Handshake: the host key callback runs before authentication.
	var hostKeyErr error
	var handshakeDone time.Time
	cfg := &ssh.ClientConfig{
		User:    t.User,
		Timeout: dialTimeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			handshakeDone = time.Now()
			line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
			info.HostKey = line
			info.Fingerprint = ssh.FingerprintSHA256(key)
			if t.HostKey != "" && t.HostKey != line {
				exp := t.HostKey
				if pk, _, _, _, perr := ssh.ParseAuthorizedKey([]byte(exp)); perr == nil {
					exp = ssh.FingerprintSHA256(pk)
				}
				hostKeyErr = &ErrHostKeyMismatch{Expected: exp, Got: info.Fingerprint}
				return hostKeyErr
			}
			return nil
		},
		BannerCallback: func(string) error { return nil },
	}
	if t.Method == "password" {
		cfg.Auth = []ssh.AuthMethod{ssh.Password(t.Password), ssh.KeyboardInteractive(
			func(_, _ string, qs []string, _ []bool) ([]string, error) {
				ans := make([]string, len(qs))
				for i := range qs {
					ans[i] = t.Password
				}
				return ans, nil
			})}
	} else {
		cfg.Auth = []ssh.AuthMethod{ssh.PublicKeys(m.signer)}
	}
	// Run the handshake in a goroutine so ctx cancellation closes the socket.
	type hs struct {
		cc    ssh.Conn
		chans <-chan ssh.NewChannel
		reqs  <-chan *ssh.Request
		err   error
	}
	ch := make(chan hs, 1)
	go func() {
		cc, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
		ch <- hs{cc, chans, reqs, err}
	}()
	var r hs
	select {
	case r = <-ch:
	case <-ctx.Done():
		raw.Close()
		r = <-ch
		if r.err == nil {
			r.cc.Close()
		}
		r.err = ctx.Err()
	}
	if r.err != nil {
		if hostKeyErr != nil {
			report("connect", start, "", hostKeyErr)
			return info, nil, hostKeyErr
		}
		if handshakeDone.IsZero() {
			err := fmt.Errorf("SSH handshake with %s failed: %w", addr, r.err)
			report("connect", start, "", err)
			return info, nil, err
		}
		info.ConnectMs = report("connect", start, "", nil)
		err := fmt.Errorf("authentication as %s failed: %s", t.User, authHint(r.err, t.Method))
		report("auth", handshakeDone, "", err)
		return info, nil, err
	}
	_ = raw.SetDeadline(time.Time{})
	info.ServerVersion = string(r.cc.ServerVersion())
	if handshakeDone.IsZero() {
		handshakeDone = time.Now()
	}
	info.ConnectMs = handshakeDone.Sub(start).Milliseconds()
	if step != nil {
		step("connect", info.ConnectMs, fmt.Sprintf("%s · %s", info.ServerVersion, info.Fingerprint), nil)
	}
	info.AuthMs = time.Since(handshakeDone).Milliseconds()
	if step != nil {
		step("auth", info.AuthMs, fmt.Sprintf("%s@%s via %s", t.User, t.Address, map[bool]string{true: "password", false: "Dockhand key"}[t.Method == "password"]), nil)
	}
	return info, ssh.NewClient(r.cc, r.chans, r.reqs), nil
}

func authHint(err error, method string) string {
	msg := err.Error()
	if strings.Contains(msg, "unable to authenticate") {
		if method == "password" {
			return "the server rejected the password"
		}
		return "the server rejected Dockhand's key — add it to ~/.ssh/authorized_keys on the host"
	}
	return msg
}

func newDockerClient(t Target, sshc *ssh.Client) (*client.Client, error) {
	if t.Method == "local" {
		return client.NewClientWithOpts(client.WithHost("unix://"+remoteSock), client.WithAPIVersionNegotiation())
	}
	return client.NewClientWithOpts(
		client.WithHost("http://docker"),
		client.WithDialContext(func(ctx context.Context, _, _ string) (net.Conn, error) {
			return sshc.DialContext(ctx, "unix", remoteSock)
		}),
		client.WithAPIVersionNegotiation(),
	)
}
