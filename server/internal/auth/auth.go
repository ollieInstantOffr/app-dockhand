// Package auth manages users, browser sessions and login rate limiting.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/secret"
)

const (
	CookieName     = "dockhand_session"
	RememberTTL    = 30 * 24 * time.Hour
	SessionTTL     = 24 * time.Hour
	MinPasswordLen = 12
)

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrSetupDone          = errors.New("setup has already been completed")
)

type Service struct {
	db      *db.DB
	limiter *Limiter
}

func New(pool *db.DB) *Service {
	return &Service{db: pool, limiter: NewLimiter(10, 15*time.Minute)}
}

func (s *Service) Limiter() *Limiter { return s.limiter }

// Session is the authenticated request context.
type Session struct {
	ID   string // sha256 hex of the token
	User model.User
}

const userCols = `id::text, name, username, role, theme, created_at`

func scanUser(row interface{ Scan(...any) error }) (model.User, error) {
	var u model.User
	err := row.Scan(&u.ID, &u.Name, &u.Username, &u.Role, &u.Theme, &u.CreatedAt)
	return u, err
}

// SetupRequired reports whether no users exist yet.
func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n == 0, err
}

// ValidatePassword checks the password policy.
func ValidatePassword(p string) error {
	if len([]rune(p)) < MinPasswordLen {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLen)
	}
	if len(p) > 72 {
		return errors.New("password must be at most 72 bytes")
	}
	return nil
}

func validUsername(u string) error {
	if u == "" || len(u) > 64 || strings.ContainsAny(u, " \t\n/") {
		return errors.New("username must be 1–64 characters without spaces")
	}
	return nil
}

// Setup creates the first (admin) user. Fails once any user exists.
func (s *Service) Setup(ctx context.Context, name, username, password string) (model.User, error) {
	username = strings.TrimSpace(strings.ToLower(username))
	if err := validUsername(username); err != nil {
		return model.User{}, err
	}
	if err := ValidatePassword(password); err != nil {
		return model.User{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return model.User{}, err
	}
	if strings.TrimSpace(name) == "" {
		name = username
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return model.User{}, err
	}
	defer tx.Rollback(ctx)
	// Serialise concurrent setup attempts.
	if _, err := tx.Exec(ctx, `LOCK TABLE users IN EXCLUSIVE MODE`); err != nil {
		return model.User{}, err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return model.User{}, err
	}
	if n > 0 {
		return model.User{}, ErrSetupDone
	}
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users (name, username, password_hash, role)
		VALUES ($1, $2, $3, 'admin') RETURNING `+userCols, strings.TrimSpace(name), username, string(hash)))
	if err != nil {
		return model.User{}, err
	}
	return u, tx.Commit(ctx)
}

// Login verifies credentials.
func (s *Service) Login(ctx context.Context, username, password string) (model.User, error) {
	var hash string
	var u model.User
	err := s.db.QueryRow(ctx, `SELECT `+userCols+`, password_hash FROM users WHERE username = $1`,
		strings.TrimSpace(strings.ToLower(username))).
		Scan(&u.ID, &u.Name, &u.Username, &u.Role, &u.Theme, &u.CreatedAt, &hash)
	if db.IsNoRows(err) {
		// Burn comparable time to avoid user enumeration.
		_ = bcrypt.CompareHashAndPassword(dummyHash(), []byte(password))
		return model.User{}, ErrInvalidCredentials
	}
	if err != nil {
		return model.User{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return model.User{}, ErrInvalidCredentials
	}
	return u, nil
}

var dummyHash = sync.OnceValue(func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("dockhand-timing-equaliser"), bcrypt.DefaultCost)
	return h
})

func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// CreateSession stores a new session and returns the raw cookie token and its expiry.
func (s *Service) CreateSession(ctx context.Context, userID, ua, ip string, remember bool) (string, time.Time, error) {
	tok := base64.RawURLEncoding.EncodeToString(secret.RandomBytes(32))
	ttl := SessionTTL
	if remember {
		ttl = RememberTTL
	}
	exp := time.Now().Add(ttl)
	_, err := s.db.Exec(ctx, `INSERT INTO sessions (id, user_id, user_agent, ip, expires_at) VALUES ($1, $2, $3, $4, $5)`,
		hashToken(tok), userID, truncate(ua, 400), ip, exp)
	return tok, exp, err
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// Authenticate resolves a raw session token, touching last_seen_at at most once a minute.
func (s *Service) Authenticate(ctx context.Context, tok, ip string) (*Session, error) {
	if tok == "" {
		return nil, errors.New("no session")
	}
	id := hashToken(tok)
	var sess Session
	var lastSeen time.Time
	err := s.db.QueryRow(ctx, `SELECT s.id, s.last_seen_at, u.id::text, u.name, u.username, u.role, u.theme, u.created_at
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()`, id).
		Scan(&sess.ID, &lastSeen, &sess.User.ID, &sess.User.Name, &sess.User.Username, &sess.User.Role, &sess.User.Theme, &sess.User.CreatedAt)
	if err != nil {
		return nil, err
	}
	if time.Since(lastSeen) > time.Minute {
		_, _ = s.db.Exec(ctx, `UPDATE sessions SET last_seen_at = now(), ip = $2 WHERE id = $1`, id, ip)
	}
	return &sess, nil
}

// DeleteSessionByToken removes the session for a raw token (logout).
func (s *Service) DeleteSessionByToken(ctx context.Context, tok string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, hashToken(tok))
	return err
}

// RevokeSession deletes one of the user's sessions. The public session id is a
// short prefix-free hash of the stored id so the stored hash never leaves the server.
func (s *Service) RevokeSession(ctx context.Context, userID, publicID string) error {
	rows, err := s.db.Query(ctx, `SELECT id FROM sessions WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	var target string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil && PublicSessionID(id) == publicID {
			target = id
		}
	}
	rows.Close()
	if target == "" {
		return errors.New("session not found")
	}
	_, err = s.db.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, target)
	return err
}

// PublicSessionID derives the id exposed to clients from a stored session id.
func PublicSessionID(storedID string) string {
	sum := sha256.Sum256([]byte(storedID))
	return hex.EncodeToString(sum[:])[:24]
}

// Account returns the user and their active sessions.
func (s *Service) Account(ctx context.Context, sess *Session) (model.Account, error) {
	acc := model.Account{User: sess.User, Sessions: []model.SessionInfo{}}
	rows, err := s.db.Query(ctx, `SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions
		WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, sess.User.ID)
	if err != nil {
		return acc, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, ua string
		var si model.SessionInfo
		if err := rows.Scan(&id, &ua, &si.IP, &si.CreatedAt, &si.LastSeenAt); err != nil {
			return acc, err
		}
		si.ID = PublicSessionID(id)
		si.Device = ParseUserAgent(ua)
		si.Current = id == sess.ID
		acc.Sessions = append(acc.Sessions, si)
	}
	return acc, rows.Err()
}

// AccountPatch is the PATCH /api/account body.
type AccountPatch struct {
	Name            *string `json:"name"`
	Username        *string `json:"username"`
	Theme           *string `json:"theme"`
	CurrentPassword string  `json:"currentPassword"`
	NewPassword     string  `json:"newPassword"`
}

// UpdateAccount applies an AccountPatch.
func (s *Service) UpdateAccount(ctx context.Context, sess *Session, p AccountPatch) (model.User, error) {
	u := sess.User
	if p.Name != nil {
		if strings.TrimSpace(*p.Name) == "" {
			return u, errors.New("name cannot be empty")
		}
		u.Name = strings.TrimSpace(*p.Name)
	}
	if p.Username != nil {
		un := strings.TrimSpace(strings.ToLower(*p.Username))
		if err := validUsername(un); err != nil {
			return u, err
		}
		u.Username = un
	}
	if p.Theme != nil {
		switch *p.Theme {
		case "light", "dark", "system":
			u.Theme = *p.Theme
		default:
			return u, errors.New("theme must be light, dark or system")
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return u, err
	}
	defer tx.Rollback(ctx)
	if p.NewPassword != "" {
		var hash string
		if err := tx.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, u.ID).Scan(&hash); err != nil {
			return u, err
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(p.CurrentPassword)) != nil {
			return u, errors.New("current password is incorrect")
		}
		if err := ValidatePassword(p.NewPassword); err != nil {
			return u, err
		}
		nh, err := bcrypt.GenerateFromPassword([]byte(p.NewPassword), bcrypt.DefaultCost)
		if err != nil {
			return u, err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, u.ID, string(nh)); err != nil {
			return u, err
		}
		// Sign out every other session.
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, u.ID, sess.ID); err != nil {
			return u, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE users SET name = $2, username = $3, theme = $4 WHERE id = $1`, u.ID, u.Name, u.Username, u.Theme)
	if err != nil {
		if strings.Contains(err.Error(), "users_username_key") {
			return u, errors.New("that username is taken")
		}
		return u, err
	}
	return u, tx.Commit(ctx)
}

// ResetPassword sets a user's password and deletes their sessions (CLI recovery).
func (s *Service) ResetPassword(ctx context.Context, username, password string) error {
	if err := ValidatePassword(password); err != nil {
		return err
	}
	nh, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	var id string
	err = s.db.QueryRow(ctx, `UPDATE users SET password_hash = $2 WHERE username = $1 RETURNING id::text`,
		strings.TrimSpace(strings.ToLower(username)), string(nh)).Scan(&id)
	if db.IsNoRows(err) {
		return fmt.Errorf("no user named %q", username)
	}
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	return err
}

// PruneSessions deletes expired sessions.
func (s *Service) PruneSessions(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	return err
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

// Limiter is a simple fixed-window failure counter per key (IP).
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string]*bucket
}

type bucket struct {
	n     int
	start time.Time
}

func NewLimiter(max int, window time.Duration) *Limiter {
	return &Limiter{max: max, window: window, hits: map[string]*bucket{}}
}

// Allowed reports whether key may attempt again.
func (l *Limiter) Allowed(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.hits[key]
	if b == nil || time.Since(b.start) > l.window {
		return true
	}
	return b.n < l.max
}

// Fail records a failed attempt.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.hits[key]
	if b == nil || time.Since(b.start) > l.window {
		b = &bucket{start: time.Now()}
		l.hits[key] = b
	}
	b.n++
	if len(l.hits) > 10000 {
		for k, v := range l.hits {
			if time.Since(v.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
}

// Reset clears a key after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}
