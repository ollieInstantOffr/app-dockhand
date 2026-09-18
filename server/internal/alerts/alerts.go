// Package alerts raises, deduplicates and resolves alerts and dispatches them
// to notification channels.
package alerts

import (
	"context"
	"log/slog"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
)

// Notification preference keys (settings.notifications).
const (
	PrefHostDown       = "hostDown"
	PrefContainerCrash = "containerCrash"
	PrefUnhealthy      = "unhealthy"
	PrefUpdates        = "updates"
	PrefDiskSpace      = "diskSpace"
	PrefDeploys        = "deploys"
	PrefNone           = ""
)

// Spec describes an alert.
type Spec struct {
	Key      string // dedupe key, e.g. "host_down:<id>"
	Severity string // crit warn info ok
	Kind     string
	Title    string
	Text     string
	HostID   string
	Action   string
	Href     string
	Pref     string // notification preference gating dispatch
}

type Engine struct {
	db       *db.DB
	settings *settings.Store
	box      *secret.Box
	root     context.Context
}

func New(root context.Context, pool *db.DB, st *settings.Store, box *secret.Box) *Engine {
	return &Engine{db: pool, settings: st, box: box, root: root}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Raise opens (or re-opens) an alert. Notifications are dispatched only when
// the alert is new or was previously resolved.
func (e *Engine) Raise(ctx context.Context, s Spec) {
	if s.Action == "" {
		s.Action = "Open"
	}
	if s.Href == "" {
		s.Href = "/"
	}
	var wasOpen bool
	err := e.db.QueryRow(ctx, `SELECT resolved_at IS NULL FROM alerts WHERE dedupe_key = $1`, s.Key).Scan(&wasOpen)
	if err != nil && !db.IsNoRows(err) {
		slog.Warn("alert lookup", "key", s.Key, "err", err)
		return
	}
	if wasOpen {
		// Refresh the text but keep read/snooze state.
		_, err = e.db.Exec(ctx, `UPDATE alerts SET severity=$2, title=$3, text=$4, action=$5, href=$6 WHERE dedupe_key=$1`,
			s.Key, s.Severity, s.Title, s.Text, s.Action, s.Href)
		if err != nil {
			slog.Warn("alert refresh", "key", s.Key, "err", err)
		}
		return
	}
	_, err = e.db.Exec(ctx, `INSERT INTO alerts (dedupe_key, severity, kind, title, text, host_id, action, href)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (dedupe_key) DO UPDATE SET severity=EXCLUDED.severity, kind=EXCLUDED.kind, title=EXCLUDED.title,
		text=EXCLUDED.text, host_id=EXCLUDED.host_id, action=EXCLUDED.action, href=EXCLUDED.href,
		created_at=now(), read_at=NULL, snoozed_until=NULL, resolved_at=NULL`,
		s.Key, s.Severity, s.Kind, s.Title, s.Text, nullable(s.HostID), s.Action, s.Href)
	if err != nil {
		slog.Warn("alert raise", "key", s.Key, "err", err)
		return
	}
	e.dispatch(s)
}

// Event records an informational alert (ok/info) that needs no resolution.
func (e *Engine) Event(ctx context.Context, s Spec) {
	if s.Action == "" {
		s.Action = "Open"
	}
	if s.Href == "" {
		s.Href = "/"
	}
	_, err := e.db.Exec(ctx, `INSERT INTO alerts (dedupe_key, severity, kind, title, text, host_id, action, href, resolved_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (dedupe_key) DO UPDATE SET severity=EXCLUDED.severity, kind=EXCLUDED.kind, title=EXCLUDED.title,
		text=EXCLUDED.text, host_id=EXCLUDED.host_id, action=EXCLUDED.action, href=EXCLUDED.href,
		created_at=now(), read_at=NULL, snoozed_until=NULL, resolved_at=now()`,
		s.Key, s.Severity, s.Kind, s.Title, s.Text, nullable(s.HostID), s.Action, s.Href)
	if err != nil {
		slog.Warn("alert event", "key", s.Key, "err", err)
		return
	}
	e.dispatch(s)
}

// Resolve closes an open alert. It reports whether one was open.
func (e *Engine) Resolve(ctx context.Context, key string) bool {
	tag, err := e.db.Exec(ctx, `UPDATE alerts SET resolved_at = now() WHERE dedupe_key = $1 AND resolved_at IS NULL`, key)
	if err != nil {
		slog.Warn("alert resolve", "key", key, "err", err)
		return false
	}
	return tag.RowsAffected() > 0
}

// ResolvePrefix closes every open alert whose key starts with prefix and is not in keep.
func (e *Engine) ResolvePrefix(ctx context.Context, prefix string, keep []string) {
	if keep == nil {
		keep = []string{}
	}
	_, err := e.db.Exec(ctx, `UPDATE alerts SET resolved_at = now() WHERE resolved_at IS NULL
		AND starts_with(dedupe_key, $1) AND NOT (dedupe_key = ANY($2))`, prefix, keep)
	if err != nil {
		slog.Warn("alert resolve prefix", "prefix", prefix, "err", err)
	}
}

const alertCols = `a.id::text, a.severity, a.kind, a.title, a.text, a.host_id::text, coalesce(h.name, ''), a.action, a.href,
	a.created_at, a.read_at IS NOT NULL, a.snoozed_until, a.resolved_at IS NOT NULL`

func scanAlert(row interface{ Scan(...any) error }) (model.Alert, error) {
	var a model.Alert
	err := row.Scan(&a.ID, &a.Severity, &a.Kind, &a.Title, &a.Text, &a.HostID, &a.HostName, &a.Action, &a.Href,
		&a.CreatedAt, &a.Read, &a.SnoozedUntil, &a.Resolved)
	return a, err
}

// List returns alerts newest first, hiding snoozed ones. filter: all|unread|critical.
func (e *Engine) List(ctx context.Context, filter string) ([]model.Alert, error) {
	q := `SELECT ` + alertCols + ` FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id
		WHERE (a.snoozed_until IS NULL OR a.snoozed_until < now())`
	switch filter {
	case "unread":
		q += ` AND a.read_at IS NULL`
	case "critical":
		q += ` AND a.severity = 'crit'`
	}
	q += ` ORDER BY a.created_at DESC LIMIT 300`
	rows, err := e.db.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Alert{}
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// OpenProblems returns unresolved, unsnoozed crit/warn alerts (for the overview).
func (e *Engine) OpenProblems(ctx context.Context) ([]model.Alert, error) {
	rows, err := e.db.Query(ctx, `SELECT `+alertCols+` FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id
		WHERE a.resolved_at IS NULL AND a.severity IN ('crit', 'warn') AND (a.snoozed_until IS NULL OR a.snoozed_until < now())
		ORDER BY CASE a.severity WHEN 'crit' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Alert{}
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UnreadCount counts unread, unsnoozed alerts.
func (e *Engine) UnreadCount(ctx context.Context) (int, error) {
	var n int
	err := e.db.QueryRow(ctx, `SELECT count(*) FROM alerts WHERE read_at IS NULL AND (snoozed_until IS NULL OR snoozed_until < now())`).Scan(&n)
	return n, err
}

func (e *Engine) MarkRead(ctx context.Context, id string) error {
	_, err := e.db.Exec(ctx, `UPDATE alerts SET read_at = coalesce(read_at, now()) WHERE id::text = $1`, id)
	return err
}

func (e *Engine) MarkAllRead(ctx context.Context) error {
	_, err := e.db.Exec(ctx, `UPDATE alerts SET read_at = now() WHERE read_at IS NULL`)
	return err
}

func (e *Engine) Snooze(ctx context.Context, id string, minutes int) error {
	if minutes <= 0 {
		minutes = 60
	}
	_, err := e.db.Exec(ctx, `UPDATE alerts SET snoozed_until = $2 WHERE id::text = $1`, id, time.Now().Add(time.Duration(minutes)*time.Minute))
	return err
}

// Prune deletes resolved alerts older than 30 days.
func (e *Engine) Prune(ctx context.Context) error {
	_, err := e.db.Exec(ctx, `DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < now() - interval '30 days'`)
	return err
}

func (e *Engine) prefEnabled(pref string) bool {
	n := e.settings.Get().Notifications
	switch pref {
	case PrefHostDown:
		return n.HostDown
	case PrefContainerCrash:
		return n.ContainerCrash
	case PrefUnhealthy:
		return n.Unhealthy
	case PrefUpdates:
		return n.Updates
	case PrefDiskSpace:
		return n.DiskSpace
	case PrefDeploys:
		return n.Deploys
	case PrefNone:
		return true
	}
	return true
}

func (e *Engine) dispatch(s Spec) {
	if !e.prefEnabled(s.Pref) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(e.root, 30*time.Second)
		defer cancel()
		chans, err := e.enabledChannels(ctx)
		if err != nil {
			slog.Warn("load channels", "err", err)
			return
		}
		hostName := ""
		if s.HostID != "" {
			_ = e.db.QueryRow(ctx, `SELECT name FROM hosts WHERE id::text = $1`, s.HostID).Scan(&hostName)
		}
		msg := Message{Severity: s.Severity, Kind: s.Kind, Title: s.Title, Text: s.Text, Host: hostName,
			URL: e.absURL(s.Href), At: time.Now()}
		for _, ch := range chans {
			if err := Send(ctx, ch, msg); err != nil {
				slog.Warn("notification failed", "channel", ch.Name, "type", ch.Type, "err", err)
			}
		}
	}()
}

func (e *Engine) absURL(href string) string {
	base := e.settings.Get().General.PublicURL
	if base == "" {
		return href
	}
	return base + href
}
