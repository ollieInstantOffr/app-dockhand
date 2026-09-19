// Package api is Dockhand's HTTP layer: the JSON API, WebSockets, the MCP
// endpoint mount and the reverse proxy to the Next.js UI.
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/alerts"
	"dockhand/internal/auth"
	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/deploycheck"
	"dockhand/internal/dockerops"
	"dockhand/internal/gitdeploy"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/machines"
	"dockhand/internal/mcp"
	"dockhand/internal/mcptools"
	"dockhand/internal/monitor"
	"dockhand/internal/registry"
	"dockhand/internal/settings"
	"dockhand/internal/sshkeys"
	"dockhand/internal/stacks"
	"dockhand/internal/system"
	"dockhand/internal/uptime"
)

// Deps bundles every service the handlers use.
type Deps struct {
	Cfg       *config.Config
	DB        *db.DB
	Auth      *auth.Service
	Settings  *settings.Store
	Hosts     *hosts.Store
	Conns     *hosts.Manager
	Monitor   *monitor.Monitor
	Ops       *dockerops.Service
	Stacks    *stacks.Service
	Jobs      *jobs.Runner
	Git       *gitdeploy.Service
	Preflight *deploycheck.Service
	Uptime    *uptime.Service
	Alerts    *alerts.Engine
	MCP       *mcptools.Provider
	System    *system.Service
	Registry  *registry.Service
	Machines  *machines.Service
	HostKey   *sshkeys.Key
	DeployKey *sshkeys.Key
}

type Server struct {
	Deps
	proxy *httputil.ReverseProxy
}

// New builds the root handler.
func New(d Deps) (http.Handler, error) {
	s := &Server{Deps: d}
	d.Registry.IP = clientIP
	target, err := url.Parse(d.Cfg.WebURL)
	if err != nil {
		return nil, fmt.Errorf("DOCKHAND_WEB_URL: %w", err)
	}
	s.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			r.SetXForwarded()
			if p := r.In.Header.Get("X-Forwarded-Proto"); p != "" {
				r.Out.Header.Set("X-Forwarded-Proto", p)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Debug("ui proxy error", "path", r.URL.Path, "err", err)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, `<!doctype html><meta http-equiv="refresh" content="3"><title>Dockhand</title>`+
				`<body style="font-family:system-ui;padding:3rem;color:#555">Dockhand's interface is starting… this page will refresh.</body>`)
		},
		FlushInterval: -1,
	}
	return s.routes(), nil
}

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(recoverer, requestLogger)

	mcpHandler := mcp.NewHandler(s.MCP, "dockhand", s.Cfg.Version)
	// Dockhand's built-in image registry (its own auth; no cookies or CSRF).
	r.Handle("/v2", s.Registry)
	r.Handle("/v2/*", s.Registry)
	r.Handle("/mcp", mcpHandler)
	r.Handle("/mcp/*", mcpHandler)
	s.registerOAuth(r)

	r.Route("/api", func(r chi.Router) {
		r.Use(s.csrf, s.authenticate, noStore)
		s.registerAPI(r)
		r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeErr(w, http.StatusNotFound, "no such endpoint") })
		r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		})
	})
	r.NotFound(s.proxy.ServeHTTP)
	r.MethodNotAllowed(s.proxy.ServeHTTP)
	return r
}

// ─── Middleware ─────────────────────────────────────────────────────────────

type ctxKey int

const sessionKey ctxKey = 1

func sessionFrom(r *http.Request) *auth.Session {
	s, _ := r.Context().Value(sessionKey).(*auth.Session)
	return s
}

func actor(r *http.Request) string {
	if s := sessionFrom(r); s != nil {
		return s.User.Username
	}
	return "unknown"
}

func isPublic(path string) bool {
	switch path {
	case "/api/healthz", "/api/auth/state", "/api/auth/setup", "/api/auth/login", "/api/github/app/callback":
		return true
	}
	return strings.HasPrefix(path, "/api/public/") || strings.HasPrefix(path, "/api/webhooks/")
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sess *auth.Session
		if c, err := r.Cookie(auth.CookieName); err == nil && c.Value != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			sess, _ = s.Auth.Authenticate(ctx, c.Value, clientIP(r))
			cancel()
		}
		if sess != nil {
			r = r.WithContext(context.WithValue(r.Context(), sessionKey, sess))
		} else if !isPublic(r.URL.Path) {
			writeErr(w, http.StatusUnauthorized, "not signed in")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if !strings.HasPrefix(r.URL.Path, "/api/webhooks/") && r.Header.Get("X-Requested-With") != "dockhand" {
				writeErr(w, http.StatusForbidden, "missing X-Requested-With: dockhand header")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				slog.Error("panic in handler", "path", r.URL.Path, "panic", p)
				writeErr(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach Flush/Hijack.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/mcp" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		lvl := slog.LevelDebug
		if sw.status >= 500 {
			lvl = slog.LevelWarn
		}
		slog.Log(r.Context(), lvl, "http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

// clientIP returns the caller's address, trusting X-Forwarded-For only from private proxies.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				p := strings.TrimSpace(parts[i])
				pip := net.ParseIP(p)
				if pip == nil {
					continue
				}
				if !(pip.IsLoopback() || pip.IsPrivate()) || i == 0 {
					return p
				}
			}
		}
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" && net.ParseIP(xr) != nil {
			return xr
		}
	}
	return host
}

func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
}

// ─── Helpers ────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func ok(w http.ResponseWriter, v any) { writeJSON(w, http.StatusOK, v) }

func empty(w http.ResponseWriter) { writeJSON(w, http.StatusOK, struct{}{}) }

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail maps service errors to HTTP statuses.
func fail(w http.ResponseWriter, err error) {
	var br *dockerops.BadRequest
	switch {
	case errors.As(err, &br):
		writeErr(w, http.StatusBadRequest, br.Msg)
	case errors.Is(err, hosts.ErrNotFound), errors.Is(err, dockerops.ErrNotFound), errors.Is(err, stacks.ErrNotFound),
		errors.Is(err, uptime.ErrNotFound), errors.Is(err, gitdeploy.ErrAccountNotFound):
		writeErr(w, http.StatusNotFound, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		writeErr(w, http.StatusGatewayTimeout, "the host did not respond in time")
	case strings.Contains(err.Error(), "cannot connect to host"):
		writeErr(w, http.StatusBadGateway, err.Error())
	case strings.HasSuffix(err.Error(), "not found"):
		writeErr(w, http.StatusNotFound, err.Error())
	default:
		slog.Debug("request failed", "err", err)
		writeErr(w, http.StatusInternalServerError, err.Error())
	}
}

const maxBody = 5 << 20

// decode reads a JSON body into dst.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	body := http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(body)
	if err := dec.Decode(dst); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func bg() context.Context { return context.Background() }

// reqCtx bounds a request's work.
func reqCtx(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
