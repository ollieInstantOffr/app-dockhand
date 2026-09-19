package system

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // window times are in the user's zone; the image may have no zoneinfo

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/settings"
)

func init() {
	settings.ValidateWindow = func(s string) error { _, err := parseWindow(s); return err }
}

// Automatic updates: when enabled, Dockhand checks for a new version every few
// minutes while inside the configured window and installs it the same way the
// Update button does. A version that failed to install isn't retried
// automatically; a newer one is.

const autoActor = "auto-update"

// window is a recurring maintenance window such as "Sun 03:00–05:00",
// "Daily 04:00–05:00" or "Any time".
type window struct {
	any        bool
	days       map[time.Weekday]bool // nil = every day
	start, end int                   // minutes after midnight; end <= start wraps past midnight
}

var windowRe = regexp.MustCompile(`^(?i)\s*([a-z,\s-]+?)\s+(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})\s*$`)

var dayNames = map[string]time.Weekday{"sun": time.Sunday, "mon": time.Monday, "tue": time.Tuesday, "wed": time.Wednesday,
	"thu": time.Thursday, "fri": time.Friday, "sat": time.Saturday}

func parseWindow(s string) (window, error) {
	t := strings.TrimSpace(s)
	if t == "" || strings.EqualFold(t, "any time") || strings.EqualFold(t, "anytime") {
		return window{any: true}, nil
	}
	m := windowRe.FindStringSubmatch(t)
	if m == nil {
		return window{}, fmt.Errorf("can't read update window %q (use e.g. \"Sun 03:00–05:00\")", s)
	}
	w := window{}
	switch d := strings.ToLower(strings.TrimSpace(m[1])); d {
	case "daily", "every day", "everyday":
	case "weekdays":
		w.days = map[time.Weekday]bool{time.Monday: true, time.Tuesday: true, time.Wednesday: true, time.Thursday: true, time.Friday: true}
	case "weekends":
		w.days = map[time.Weekday]bool{time.Saturday: true, time.Sunday: true}
	default:
		w.days = map[time.Weekday]bool{}
		for _, part := range strings.FieldsFunc(d, func(r rune) bool { return r == ',' || r == ' ' }) {
			wd, ok := dayNames[strings.TrimSpace(part)[:min(3, len(strings.TrimSpace(part)))]]
			if !ok {
				return window{}, fmt.Errorf("unknown day %q in update window", part)
			}
			w.days[wd] = true
		}
	}
	var h1, m1, h2, m2 int
	fmt.Sscan(m[2], &h1)
	fmt.Sscan(m[3], &m1)
	fmt.Sscan(m[4], &h2)
	fmt.Sscan(m[5], &m2)
	if h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59 {
		return window{}, fmt.Errorf("bad time in update window %q", s)
	}
	w.start, w.end = h1*60+m1, h2*60+m2
	return w, nil
}

// contains reports whether t (already in the window's zone) falls inside the window.
func (w window) contains(t time.Time) bool {
	if w.any {
		return true
	}
	mins := t.Hour()*60 + t.Minute()
	day := t.Weekday()
	if w.end > w.start {
		return w.dayOK(day) && mins >= w.start && mins < w.end
	}
	// Wraps midnight: the part after midnight belongs to the previous day's window.
	if mins >= w.start {
		return w.dayOK(day)
	}
	return mins < w.end && w.dayOK((day+6)%7)
}

func (w window) dayOK(d time.Weekday) bool { return w.days == nil || w.days[d] }

// next returns when the window next opens at or after t (t itself when already inside).
func (w window) next(t time.Time) time.Time {
	if w.contains(t) {
		return t
	}
	base := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	for i := 0; i <= 8; i++ {
		d := base.AddDate(0, 0, i)
		open := d.Add(time.Duration(w.start) * time.Minute)
		if w.dayOK(d.Weekday()) && open.After(t) {
			return open
		}
	}
	return time.Time{}
}

func (s *Service) location() *time.Location {
	tz := strings.TrimSpace(s.settings.Get().Updates.Timezone)
	if tz == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Local
	}
	return loc
}

// AutoStatus describes the automatic update schedule for the UI.
func (s *Service) AutoStatus() model.AutoUpdateStatus {
	up := s.settings.Get().Updates
	loc := s.location()
	st := model.AutoUpdateStatus{Enabled: up.Auto, Timezone: loc.String()}
	w, err := parseWindow(up.Window)
	if err != nil {
		st.Error = err.Error()
	} else if up.Auto {
		now := time.Now().In(loc)
		st.InWindow = w.contains(now)
		if n := w.next(now); !n.IsZero() {
			st.NextWindow = &n
		}
	}
	s.mu.Lock()
	st.LastCheck, st.LastResult = s.autoAt, s.autoResult
	s.mu.Unlock()
	return st
}

// RunAutoUpdates checks every five minutes whether an automatic update is due.
func (s *Service) RunAutoUpdates(ctx context.Context) {
	// Let the boot-time checkout read and history reconciliation settle first.
	select {
	case <-ctx.Done():
		return
	case <-time.After(2 * time.Minute):
	}
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		s.autoTick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) autoTick(ctx context.Context) {
	up := s.settings.Get().Updates
	if !up.Auto || !CanSelfUpdate() {
		return
	}
	w, err := parseWindow(up.Window)
	if err != nil {
		s.setAuto("Skipped: " + err.Error())
		return
	}
	if !w.contains(time.Now().In(s.location())) {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result, err := s.autoUpdate(cctx)
	if err != nil {
		slog.Warn("automatic update", "err", err)
		result = "Failed: " + err.Error()
	} else if result != "" {
		slog.Info("automatic update", "result", result)
	}
	s.setAuto(result)
}

func (s *Service) setAuto(result string) {
	now := time.Now()
	s.mu.Lock()
	s.autoAt = &now
	if result != "" {
		s.autoResult = result
	}
	s.mu.Unlock()
}

// autoUpdate starts an update when one is available and it's safe to.
func (s *Service) autoUpdate(ctx context.Context) (string, error) {
	// Don't overlap a running update (from the button, or one still restarting).
	var pending int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM update_history WHERE status = 'pending' AND at > now() - interval '30 minutes'`).Scan(&pending); err != nil {
		return "", err
	}
	if pending > 0 || s.jobs.Running("self-update") {
		return "Waiting for the update in progress", nil
	}
	info, err := s.Info(ctx, true)
	if err != nil {
		return "", err
	}
	if info.CheckError != "" {
		return "", errors.New(info.CheckError)
	}
	if !info.UpdateAvailable {
		return "Up to date", nil
	}
	target := info.Latest
	// A version that failed once needs a person to look at it; a newer one is tried again.
	var failed int
	err = s.db.QueryRow(ctx, `SELECT count(*) FROM update_history WHERE status = 'failed' AND (version = $1 OR version LIKE $1 || '%')`, target).Scan(&failed)
	if err != nil && !db.IsNoRows(err) {
		return "", err
	}
	if failed > 0 {
		return fmt.Sprintf("Skipped %s: it failed to install before — update from Settings → Updates", target), nil
	}
	id, err := s.Update(ctx, autoActor)
	if err != nil {
		return "", err
	}
	if s.OnAutoUpdate != nil {
		s.OnAutoUpdate(target, id)
	}
	return "Started update to " + target, nil
}
