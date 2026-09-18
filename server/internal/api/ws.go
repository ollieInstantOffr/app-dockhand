package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"dockhand/internal/dockerops"
	"dockhand/internal/hosts"
)

func (s *Server) upgrader() *websocket.Upgrader {
	return &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 32 * 1024,
		CheckOrigin:     s.checkOrigin,
	}
}

// checkOrigin allows same-origin requests, the configured public URL and localhost (dev).
func (s *Server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	if pub, err := url.Parse(s.Settings.Get().General.PublicURL); err == nil && strings.EqualFold(pub.Host, u.Host) {
		return true
	}
	if pub, err := url.Parse(s.Cfg.PublicURL); err == nil && strings.EqualFold(pub.Host, u.Host) {
		return true
	}
	h := u.Hostname()
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	// Same hostname on a different port (e.g. `next dev` on :3000 talking to :8080).
	rh, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		rh = r.Host
	}
	return strings.EqualFold(rh, h)
}

// wsConn serialises writes on a websocket.
type wsConn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (w *wsConn) write(typ int, b []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return w.c.WriteMessage(typ, b)
}

func (w *wsConn) writeJSON(v any) error {
	b, _ := json.Marshal(v)
	return w.write(websocket.TextMessage, b)
}

func (w *wsConn) close(code int, text string) {
	w.mu.Lock()
	_ = w.c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(2*time.Second))
	w.mu.Unlock()
	_ = w.c.Close()
}

// pinger keeps idle sockets alive until ctx ends.
func (w *wsConn) pinger(ctx context.Context) {
	t := time.NewTicker(25 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.mu.Lock()
			err := w.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			w.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func (s *Server) containerLogsWS(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	cid := chi.URLParam(r, "cid")
	q := r.URL.Query()
	opts := dockerops.LogOpts{Tail: q.Get("tail"), Since: q.Get("since"), Follow: q.Get("follow") != "0" && q.Get("follow") != "false"}
	if opts.Tail == "" {
		opts.Tail = "200"
	}
	c, err := s.upgrader().Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws := &wsConn{c: c}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Reader: detect client close.
	go func() {
		defer cancel()
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}()
	go ws.pinger(ctx)
	err = s.Ops.Logs(ctx, id, cid, opts, func(l dockerops.LogLine) error {
		return ws.writeJSON(l)
	})
	if err != nil && ctx.Err() == nil {
		_ = ws.writeJSON(dockerops.LogLine{T: time.Now().UTC(), Stream: "stderr", Line: "[dockhand] " + err.Error()})
		ws.close(websocket.CloseInternalServerErr, truncateReason(err.Error()))
		return
	}
	ws.close(websocket.CloseNormalClosure, "end of log stream")
}

func truncateReason(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}

func sizeParams(r *http.Request) (int, int) {
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 || cols > 1000 {
		cols = 120
	}
	if rows <= 0 || rows > 500 {
		rows = 32
	}
	return cols, rows
}

func (s *Server) containerExec(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	cols, rows := sizeParams(r)
	cmd := r.URL.Query().Get("cmd")
	if cmd == "" {
		cmd = "/bin/sh"
	}
	cid := chi.URLParam(r, "cid")
	who := actor(r)
	s.terminal(w, r, func(ctx context.Context) (hosts.Terminal, error) {
		t, err := s.Ops.Exec(ctx, id, cid, cmd, cols, rows)
		if err == nil {
			slog.Info("container exec", "host", id, "container", cid, "cmd", cmd, "user", who)
		}
		return t, err
	})
}

func (s *Server) hostShell(w http.ResponseWriter, r *http.Request) {
	id, okk := s.hostID(w, r)
	if !okk {
		return
	}
	cols, rows := sizeParams(r)
	who := actor(r)
	s.terminal(w, r, func(ctx context.Context) (hosts.Terminal, error) {
		dctx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		conn, err := s.Conns.Get(dctx, id)
		if err != nil {
			return nil, err
		}
		t, err := conn.Shell(ctx, cols, rows)
		if err == nil {
			slog.Info("host shell opened", "host", id, "user", who)
		}
		return t, err
	})
}

type termMsg struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// terminal bridges a PTY session and a websocket (see the terminal protocol in docs/API.md).
func (s *Server) terminal(w http.ResponseWriter, r *http.Request, open func(context.Context) (hosts.Terminal, error)) {
	c, err := s.upgrader().Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws := &wsConn{c: c}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	term, err := open(ctx)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, hosts.ErrNoShell) {
			msg = hosts.ErrNoShell.Error()
		}
		_ = ws.write(websocket.BinaryMessage, []byte("\r\n\x1b[31m[dockhand] "+msg+"\x1b[0m\r\n"))
		_ = ws.writeJSON(map[string]any{"type": "exit", "code": 1})
		ws.close(websocket.CloseNormalClosure, "")
		return
	}
	defer term.Close()
	go ws.pinger(ctx)

	// Client → PTY
	go func() {
		defer cancel()
		for {
			typ, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			if typ == websocket.BinaryMessage {
				if _, err := term.Write(data); err != nil {
					return
				}
				continue
			}
			var m termMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.Type {
			case "input":
				if _, err := term.Write([]byte(m.Data)); err != nil {
					return
				}
			case "resize":
				if m.Cols > 0 && m.Rows > 0 {
					_ = term.Resize(m.Cols, m.Rows)
				}
			}
		}
	}()

	// PTY → client
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				if werr := ws.write(websocket.BinaryMessage, append([]byte(nil), buf[:n]...)); werr != nil {
					cancel()
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && ctx.Err() == nil {
					slog.Debug("terminal read", "err", err)
				}
				return
			}
		}
	}()

	select {
	case <-done:
		code := term.Wait()
		_ = ws.writeJSON(map[string]any{"type": "exit", "code": code})
		ws.close(websocket.CloseNormalClosure, "")
	case <-ctx.Done():
		_ = term.Close()
		_ = c.Close()
	}
}
