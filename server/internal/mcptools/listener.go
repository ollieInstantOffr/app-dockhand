package mcptools

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// dedicated tracks the optional extra MCP listener (settings.mcp.port).
type dedicated struct {
	mu   sync.Mutex
	port int    // port currently listening (0 = none)
	err  string // last listen error for the wanted port
}

func (p *Provider) listenState() (int, string) {
	p.ded.mu.Lock()
	defer p.ded.mu.Unlock()
	return p.ded.port, p.ded.err
}

// endpointURL is the public MCP URL: Dockhand's public URL + /mcp, with the
// dedicated port swapped in when one is configured.
func endpointURL(publicURL string, port int) string {
	base := strings.TrimRight(publicURL, "/")
	if port > 0 {
		if u, err := url.Parse(base); err == nil && u.Host != "" {
			u.Host = net.JoinHostPort(u.Hostname(), strconv.Itoa(port))
			u.Path = ""
			return strings.TrimRight(u.String(), "/") + "/mcp"
		}
	}
	return base + "/mcp"
}

// RunDedicated serves h at /mcp on settings.mcp.port while the MCP server is
// enabled and a port is set, (re)starting the listener when the setting changes.
// It returns when ctx is cancelled.
func (p *Provider) RunDedicated(ctx context.Context, h http.Handler) {
	mux := http.NewServeMux()
	mux.Handle("/mcp", h)
	mux.Handle("/mcp/", h)

	var srv *http.Server
	var failedPort int
	stop := func() {
		if srv == nil {
			return
		}
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = srv.Shutdown(c)
		cancel()
		srv = nil
		p.ded.mu.Lock()
		p.ded.port = 0
		p.ded.mu.Unlock()
	}
	defer stop()

	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		m := p.settings.Get().MCP
		want := 0
		if m.Enabled && m.Port > 0 {
			want = m.Port
		}
		cur, _ := p.listenState()
		if want != cur && !(want == failedPort && want != 0) {
			stop()
			failedPort = 0
			p.ded.mu.Lock()
			p.ded.err = ""
			p.ded.mu.Unlock()
			if want > 0 {
				ln, err := net.Listen("tcp", fmt.Sprintf(":%d", want))
				if err != nil {
					failedPort = want
					p.ded.mu.Lock()
					p.ded.err = err.Error()
					p.ded.mu.Unlock()
					slog.Warn("mcp listener", "port", want, "err", err)
				} else {
					s := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 120 * time.Second}
					srv = s
					p.ded.mu.Lock()
					p.ded.port = want
					p.ded.mu.Unlock()
					slog.Info("mcp listening on dedicated port", "port", want)
					go func() {
						if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
							slog.Warn("mcp listener stopped", "port", want, "err", err)
						}
					}()
				}
			}
		}
		if want == 0 {
			failedPort = 0
			p.ded.mu.Lock()
			p.ded.err = ""
			p.ded.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
