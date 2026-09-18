package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"dockhand/internal/auth"
	"dockhand/internal/model"
)

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, tok string, exp time.Time, remember bool) {
	c := &http.Cookie{Name: auth.CookieName, Value: tok, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r)}
	if remember {
		c.Expires = exp
		c.MaxAge = int(time.Until(exp).Seconds())
	}
	http.SetCookie(w, c)
}

func (s *Server) authState(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 5*time.Second)
	defer cancel()
	req, err := s.Auth.SetupRequired(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	st := model.AuthState{SetupRequired: req, Version: s.Cfg.Version}
	if sess := sessionFrom(r); sess != nil {
		u := sess.User
		st.User = &u
	}
	ok(w, st)
}

func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Username, Password string }
	if !decode(w, r, &in) {
		return
	}
	ctx, cancel := reqCtx(r, 10*time.Second)
	defer cancel()
	u, err := s.Auth.Setup(ctx, in.Name, in.Username, in.Password)
	if errors.Is(err, auth.ErrSetupDone) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	tok, exp, err := s.Auth.CreateSession(ctx, u.ID, r.UserAgent(), clientIP(r), true)
	if err != nil {
		fail(w, err)
		return
	}
	s.setSessionCookie(w, r, tok, exp, true)
	ok(w, u)
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username, Password string
		Remember           bool
	}
	if !decode(w, r, &in) {
		return
	}
	ip := clientIP(r)
	lim := s.Auth.Limiter()
	if !lim.Allowed(ip) {
		w.Header().Set("Retry-After", "900")
		writeErr(w, http.StatusTooManyRequests, "too many failed sign-in attempts — try again in 15 minutes")
		return
	}
	ctx, cancel := reqCtx(r, 10*time.Second)
	defer cancel()
	u, err := s.Auth.Login(ctx, in.Username, in.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		lim.Fail(ip)
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	lim.Reset(ip)
	tok, exp, err := s.Auth.CreateSession(ctx, u.ID, r.UserAgent(), ip, in.Remember)
	if err != nil {
		fail(w, err)
		return
	}
	s.setSessionCookie(w, r, tok, exp, in.Remember)
	ok(w, u)
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		_ = s.Auth.DeleteSessionByToken(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r)})
	empty(w)
}

func (s *Server) account(w http.ResponseWriter, r *http.Request) {
	acc, err := s.Auth.Account(r.Context(), sessionFrom(r))
	if err != nil {
		fail(w, err)
		return
	}
	ok(w, acc)
}

func (s *Server) patchAccount(w http.ResponseWriter, r *http.Request) {
	var in auth.AccountPatch
	if !decode(w, r, &in) {
		return
	}
	u, err := s.Auth.UpdateAccount(r.Context(), sessionFrom(r), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, u)
}

func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request) {
	if err := s.Auth.RevokeSession(r.Context(), sessionFrom(r).User.ID, chi.URLParam(r, "id")); err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	empty(w)
}

func (s *Server) sshKey(w http.ResponseWriter, r *http.Request)    { ok(w, s.HostKey.Info()) }
func (s *Server) deployKey(w http.ResponseWriter, r *http.Request) { ok(w, s.DeployKey.Info()) }

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 3*time.Second)
	defer cancel()
	if err := s.DB.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "database unreachable"})
		return
	}
	ok(w, map[string]bool{"ok": true})
}
