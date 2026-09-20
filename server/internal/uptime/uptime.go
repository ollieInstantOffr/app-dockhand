package uptime

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"dockhand/internal/alerts"
	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/settings"
	"dockhand/internal/util"
)

var ErrNotFound = errors.New("monitor not found")

type Service struct {
	db       *db.DB
	settings *settings.Store
	mon      *monitor.Monitor
	alerts   *alerts.Engine
	http     *http.Client

	running sync.Map // monitor id → struct{} while a check runs
}

func New(pool *db.DB, st *settings.Store, mon *monitor.Monitor, al *alerts.Engine) *Service {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return &Service{db: pool, settings: st, mon: mon, alerts: al, http: &http.Client{Timeout: 10 * time.Second, Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return http.ErrUseLastResponse
			}
			return nil
		}}}
}

// Monitor is a monitors row.
type Monitor struct {
	ID          string
	Name        string
	Type        string
	HostID      *string
	HostName    string
	HostAddr    string
	HostPort    int
	HostMethod  string
	HostStatus  string
	HostMonitor bool // hosts.monitored
	Target      string
	Expect      string
	Enabled     bool
	Auto        bool
	Status      string
	FailCount   int
	LastCheckAt *time.Time
	LastLatency int
}

const monCols = `m.id::text, m.name, m.type, m.host_id::text, coalesce(h.name, ''), coalesce(h.address, ''), coalesce(h.port, 22),
	coalesce(h.method, ''), coalesce(h.status, ''), coalesce(h.monitored, true), m.target, m.expect, m.enabled, m.auto, m.status,
	m.fail_count, m.last_check_at, m.last_latency`

func scanMon(row interface{ Scan(...any) error }) (Monitor, error) {
	var m Monitor
	err := row.Scan(&m.ID, &m.Name, &m.Type, &m.HostID, &m.HostName, &m.HostAddr, &m.HostPort, &m.HostMethod, &m.HostStatus,
		&m.HostMonitor, &m.Target, &m.Expect, &m.Enabled, &m.Auto, &m.Status, &m.FailCount, &m.LastCheckAt, &m.LastLatency)
	return m, err
}

func (s *Service) monitors(ctx context.Context, where string, args ...any) ([]Monitor, error) {
	rows, err := s.db.Query(ctx, `SELECT `+monCols+` FROM monitors m LEFT JOIN hosts h ON h.id = m.host_id `+where+
		` ORDER BY m.type = 'host' DESC, lower(m.name)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Monitor{}
	for rows.Next() {
		m, err := scanMon(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Service) get(ctx context.Context, id string) (Monitor, error) {
	ms, err := s.monitors(ctx, `WHERE m.id::text = $1`, id)
	if err != nil {
		return Monitor{}, err
	}
	if len(ms) == 0 {
		return Monitor{}, ErrNotFound
	}
	return ms[0], nil
}

// EnsureHostMonitors creates a host monitor for every host lacking one.
// All returns every monitor (used by the impact graph).
func (s *Service) All(ctx context.Context) ([]Monitor, error) { return s.monitors(ctx, "") }

func (s *Service) EnsureHostMonitors(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `INSERT INTO monitors (name, type, host_id, target, auto)
		SELECT h.name, 'host', h.id, h.address, true FROM hosts h
		WHERE NOT EXISTS (SELECT 1 FROM monitors m WHERE m.host_id = h.id AND m.type = 'host')`)
	return err
}

// SyncHostMonitor renames a host's monitor after a host edit.
func (s *Service) SyncHostMonitor(ctx context.Context, hostID, name, address string) {
	_, _ = s.db.Exec(ctx, `UPDATE monitors SET name = $2, target = $3 WHERE host_id::text = $1 AND type = 'host'`, hostID, name, address)
}

// Create adds a docker/http/tcp monitor.
func (s *Service) Create(ctx context.Context, in model.MonitorInput) (model.MonitorView, error) {
	in.Name, in.Target = strings.TrimSpace(in.Name), strings.TrimSpace(in.Target)
	if in.Target == "" {
		return model.MonitorView{}, &dockerops.BadRequest{Msg: "target is required"}
	}
	if in.HostID != nil && *in.HostID == "" {
		in.HostID = nil
	}
	switch in.Type {
	case "docker":
		if in.HostID == nil {
			return model.MonitorView{}, &dockerops.BadRequest{Msg: "docker monitors need a host"}
		}
	case "http":
		if !strings.HasPrefix(in.Target, "http://") && !strings.HasPrefix(in.Target, "https://") {
			return model.MonitorView{}, &dockerops.BadRequest{Msg: "http monitors need a URL starting with http:// or https://"}
		}
		if _, err := ParseExpect(in.Expect); err != nil {
			return model.MonitorView{}, &dockerops.BadRequest{Msg: err.Error()}
		}
	case "tcp":
		if _, _, err := net.SplitHostPort(in.Target); err != nil && in.HostID == nil {
			return model.MonitorView{}, &dockerops.BadRequest{Msg: "tcp monitors need host:port"}
		}
	default:
		return model.MonitorView{}, &dockerops.BadRequest{Msg: "type must be docker, http or tcp"}
	}
	if in.Name == "" {
		in.Name = in.Target
	}
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO monitors (name, type, host_id, target, expect) VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
		in.Name, in.Type, in.HostID, in.Target, strings.TrimSpace(in.Expect)).Scan(&id)
	if err != nil {
		return model.MonitorView{}, err
	}
	m, err := s.get(ctx, id)
	if err != nil {
		return model.MonitorView{}, err
	}
	s.CheckOne(ctx, m)
	return s.View(ctx, id, "24h")
}

// Patch is the PATCH body.
type Patch struct {
	Enabled *bool   `json:"enabled"`
	Name    *string `json:"name"`
	Target  *string `json:"target"`
	Expect  *string `json:"expect"`
}

// Update applies a patch.
func (s *Service) Update(ctx context.Context, id string, p Patch) (model.MonitorView, error) {
	m, err := s.get(ctx, id)
	if err != nil {
		return model.MonitorView{}, err
	}
	if p.Enabled != nil {
		m.Enabled = *p.Enabled
	}
	if p.Name != nil && strings.TrimSpace(*p.Name) != "" {
		m.Name = strings.TrimSpace(*p.Name)
	}
	if p.Target != nil && strings.TrimSpace(*p.Target) != "" && m.Type != "host" {
		m.Target = strings.TrimSpace(*p.Target)
	}
	if p.Expect != nil {
		if _, err := ParseExpect(*p.Expect); err != nil {
			return model.MonitorView{}, &dockerops.BadRequest{Msg: err.Error()}
		}
		m.Expect = strings.TrimSpace(*p.Expect)
	}
	status := m.Status
	if !m.Enabled {
		status = "paused"
	} else if status == "paused" {
		status = "unknown"
	}
	_, err = s.db.Exec(ctx, `UPDATE monitors SET enabled=$2, name=$3, target=$4, expect=$5, status=$6 WHERE id::text=$1`,
		id, m.Enabled, m.Name, m.Target, m.Expect, status)
	if err != nil {
		return model.MonitorView{}, err
	}
	if !m.Enabled {
		s.closeIncident(ctx, id)
		s.alerts.Resolve(ctx, "monitor_down:"+id)
	}
	return s.View(ctx, id, "24h")
}

// Delete removes a monitor.
func (s *Service) Delete(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM monitors WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.alerts.Resolve(ctx, "monitor_down:"+id)
	return nil
}

// CheckNow runs a monitor check immediately.
func (s *Service) CheckNow(ctx context.Context, id string) (model.MonitorView, error) {
	m, err := s.get(ctx, id)
	if err != nil {
		return model.MonitorView{}, err
	}
	s.CheckOne(ctx, m)
	return s.View(ctx, id, "24h")
}

// AutoMonitor creates a docker monitor for a newly started container with a healthcheck.
func (s *Service) AutoMonitor(hostID, name string, hasHealth bool) {
	if !hasHealth || !s.settings.Get().Uptime.AutoMonitor {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Skip Dockhand's own helpers and transient recreate names.
	if strings.Contains(name, "-dockhand-old-") {
		return
	}
	_, err := s.db.Exec(ctx, `INSERT INTO monitors (name, type, host_id, target, auto)
		SELECT $2, 'docker', $1::uuid, $2, true WHERE NOT EXISTS
		(SELECT 1 FROM monitors WHERE host_id = $1::uuid AND type = 'docker' AND target = $2)`, hostID, name)
	if err != nil {
		slog.Warn("auto monitor", "err", err)
	}
}

// Run executes the check scheduler until ctx ends.
func (s *Service) Run(ctx context.Context) {
	if err := s.EnsureHostMonitors(ctx); err != nil {
		slog.Warn("ensure host monitors", "err", err)
	}
	next := time.Now().Add(15 * time.Second) // let the poller warm up first
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(next)):
		}
		iv := time.Duration(s.settings.Get().Uptime.IntervalSec) * time.Second
		if iv < 10*time.Second {
			iv = 60 * time.Second
		}
		next = time.Now().Add(iv)
		s.checkAll(ctx)
	}
}

func (s *Service) checkAll(ctx context.Context) {
	ms, err := s.monitors(ctx, `WHERE m.enabled`)
	if err != nil {
		slog.Warn("uptime: list monitors", "err", err)
		return
	}
	sem := make(chan struct{}, 16)
	var wg sync.WaitGroup
	for _, m := range ms {
		wg.Add(1)
		sem <- struct{}{}
		go func(m Monitor) {
			defer func() { <-sem; wg.Done() }()
			s.CheckOne(ctx, m)
		}(m)
	}
	wg.Wait()
}

func (s *Service) hostIncluded(m Monitor) bool {
	ids := s.settings.Get().Uptime.HostIDs
	if m.HostID == nil || len(ids) == 0 {
		return true
	}
	return util.Contains(ids, *m.HostID)
}

// CheckOne runs one check and records the result.
func (s *Service) CheckOne(ctx context.Context, m Monitor) {
	if _, busy := s.running.LoadOrStore(m.ID, struct{}{}); busy {
		return
	}
	defer s.running.Delete(m.ID)
	if m.Type == "host" && (!m.HostMonitor || !s.hostIncluded(m)) {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	status, latency, msg := s.check(cctx, m)
	cancel()
	if ctx.Err() != nil {
		return
	}
	s.record(context.Background(), m, status, latency, msg)
}

func (s *Service) check(ctx context.Context, m Monitor) (string, int, string) {
	start := time.Now()
	ms := func() int { return int(time.Since(start).Milliseconds()) }
	switch m.Type {
	case "host":
		if m.HostStatus == "offline" {
			return "down", 0, "host is offline"
		}
		if m.HostMethod == "local" {
			if m.HostStatus == "degraded" {
				return "degraded", 0, "host is degraded"
			}
			return "up", 0, ""
		}
		d := net.Dialer{Timeout: 5 * time.Second}
		c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(m.HostAddr, fmt.Sprint(m.HostPort)))
		if err != nil {
			return "down", ms(), "SSH port unreachable: " + err.Error()
		}
		c.Close()
		lat := ms()
		if m.HostStatus == "degraded" {
			return "degraded", lat, "host is degraded"
		}
		return "up", lat, ""
	case "docker":
		if m.HostID == nil {
			return "down", 0, "no host"
		}
		if m.HostStatus == "offline" {
			return "down", 0, "host is offline"
		}
		c, ok := s.mon.Container(*m.HostID, m.Target)
		if !ok {
			return "down", 0, "container " + m.Target + " not found"
		}
		switch {
		case c.State != "running":
			return "down", 0, fmt.Sprintf("container is %s", c.State)
		case c.Health == "unhealthy":
			return "down", 0, "health check failing"
		case c.Health == "starting":
			return "degraded", 0, "health check starting"
		}
		return "up", 0, ""
	case "http":
		expect, err := ParseExpect(m.Expect)
		if err != nil {
			return "down", 0, err.Error()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.Target, nil)
		if err != nil {
			return "down", 0, err.Error()
		}
		req.Header.Set("User-Agent", "Dockhand-Uptime/1.0")
		resp, err := s.http.Do(req)
		if err != nil {
			return "down", ms(), shortErr(err)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		lat := ms()
		if !expect(resp.StatusCode) {
			return "down", lat, fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		if lat > 2000 {
			return "degraded", lat, fmt.Sprintf("slow response (%d ms)", lat)
		}
		return "up", lat, ""
	case "tcp":
		target := m.Target
		if _, _, err := net.SplitHostPort(target); err != nil && m.HostAddr != "" {
			target = net.JoinHostPort(m.HostAddr, strings.TrimPrefix(target, ":"))
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		c, err := d.DialContext(ctx, "tcp", target)
		if err != nil {
			return "down", ms(), shortErr(err)
		}
		c.Close()
		lat := ms()
		if lat > 2000 {
			return "degraded", lat, fmt.Sprintf("slow connect (%d ms)", lat)
		}
		return "up", lat, ""
	}
	return "down", 0, "unknown monitor type"
}

func shortErr(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && len(msg)-i < 80 {
		return msg[i+2:]
	}
	return util.Truncate(msg, 160)
}

func (s *Service) record(ctx context.Context, m Monitor, status string, latency int, msg string) {
	retries := s.settings.Get().Uptime.Retries
	if retries < 1 {
		retries = 1
	}
	fails := 0
	if status == "down" {
		fails = m.FailCount + 1
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO check_results (monitor_id, status, latency_ms, message) VALUES ($1, $2, $3, $4)`,
		m.ID, status, latency, util.Truncate(msg, 500)); err != nil {
		slog.Warn("uptime: record", "err", err)
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE monitors SET status=$2, fail_count=$3, last_check_at=now(), last_latency=$4 WHERE id::text=$1`,
		m.ID, status, fails, latency)
	name := m.Name
	if m.HostName != "" && m.Type != "host" {
		name += " on " + m.HostName
	}
	if status == "down" && fails >= retries {
		var open bool
		_ = s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM incidents WHERE monitor_id::text = $1 AND ended_at IS NULL)`, m.ID).Scan(&open)
		if !open {
			_, _ = s.db.Exec(ctx, `INSERT INTO incidents (monitor_id, status, message) VALUES ($1, 'down', $2)`, m.ID, util.Truncate(msg, 500))
		}
		if s.settings.Get().Uptime.Notify && m.Type != "host" {
			hostID := ""
			if m.HostID != nil {
				hostID = *m.HostID
			}
			s.alerts.Raise(ctx, alerts.Spec{Key: "monitor_down:" + m.ID, Severity: "crit", Kind: "monitor_down", Title: name + " is down",
				Text: msg, HostID: hostID, Action: "Open uptime", Href: "/uptime", Pref: alerts.PrefNone})
		}
	} else if status != "down" {
		s.closeIncident(ctx, m.ID)
		s.alerts.Resolve(ctx, "monitor_down:"+m.ID)
	}
}

func (s *Service) closeIncident(ctx context.Context, id string) {
	_, _ = s.db.Exec(ctx, `UPDATE incidents SET ended_at = now() WHERE monitor_id::text = $1 AND ended_at IS NULL`, id)
}

// Prune deletes old check results and incidents.
func (s *Service) Prune(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM check_results WHERE at < now() - interval '31 days'`); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < now() - interval '90 days'`)
	return err
}

// ─── Views ──────────────────────────────────────────────────────────────────

type windowData struct {
	from      time.Time
	size      time.Duration
	buckets   map[string]map[int]Counts
	totals    map[string]Counts
	incidents map[string]int
}

func (s *Service) loadWindow(ctx context.Context, window time.Duration, monitorID string) (windowData, error) {
	now := time.Now()
	size := window / NumBars
	from := now.Add(-window)
	wd := windowData{from: from, size: size, buckets: map[string]map[int]Counts{}, totals: map[string]Counts{}, incidents: map[string]int{}}
	q := `SELECT monitor_id::text, floor(extract(epoch from (at - $1::timestamptz)) / $2)::int AS b,
		count(*) FILTER (WHERE status = 'up'), count(*) FILTER (WHERE status = 'degraded'), count(*) FILTER (WHERE status = 'down'),
		coalesce(sum(latency_ms) FILTER (WHERE status <> 'down' AND latency_ms > 0), 0), count(*) FILTER (WHERE status <> 'down' AND latency_ms > 0)
		FROM check_results WHERE at >= $1`
	args := []any{from, size.Seconds()}
	if monitorID != "" {
		q += ` AND monitor_id::text = $3`
		args = append(args, monitorID)
	}
	rows, err := s.db.Query(ctx, q+` GROUP BY 1, 2`, args...)
	if err != nil {
		return wd, err
	}
	for rows.Next() {
		var id string
		var b int
		var c Counts
		var latSum int64
		if err := rows.Scan(&id, &b, &c.Up, &c.Degraded, &c.Down, &latSum, &c.LatencyN); err != nil {
			rows.Close()
			return wd, err
		}
		c.LatencySum = float64(latSum)
		if b >= NumBars {
			b = NumBars - 1
		}
		if wd.buckets[id] == nil {
			wd.buckets[id] = map[int]Counts{}
		}
		cur := wd.buckets[id][b]
		cur.Add(c)
		wd.buckets[id][b] = cur
		t := wd.totals[id]
		t.Add(c)
		wd.totals[id] = t
	}
	rows.Close()
	irows, err := s.db.Query(ctx, `SELECT monitor_id::text, count(*) FROM incidents WHERE started_at >= $1 OR ended_at IS NULL OR ended_at >= $1 GROUP BY 1`, from)
	if err != nil {
		return wd, err
	}
	for irows.Next() {
		var id string
		var n int
		if irows.Scan(&id, &n) == nil {
			wd.incidents[id] = n
		}
	}
	irows.Close()
	return wd, nil
}

func (wd windowData) view(m Monitor) model.MonitorView {
	status := m.Status
	if !m.Enabled {
		status = "paused"
	}
	switch status {
	case "up", "degraded", "down", "unknown", "paused":
	default:
		status = "unknown"
	}
	t := wd.totals[m.ID]
	return model.MonitorView{ID: m.ID, Name: m.Name, Type: m.Type, HostID: m.HostID, HostName: m.HostName, Target: m.Target,
		Enabled: m.Enabled, Auto: m.Auto, Status: status, Pct: t.Pct(), LatencyMs: t.AvgLatency(), Incidents: wd.incidents[m.ID],
		LastCheckAt: m.LastCheckAt, Bars: BuildBars(wd.buckets[m.ID], wd.from, wd.size, NumBars)}
}

// View returns one monitor over a window.
func (s *Service) View(ctx context.Context, id, window string) (model.MonitorView, error) {
	m, err := s.get(ctx, id)
	if err != nil {
		return model.MonitorView{}, err
	}
	_, dur := WindowDuration(window)
	wd, err := s.loadWindow(ctx, dur, id)
	if err != nil {
		return model.MonitorView{}, err
	}
	return wd.view(m), nil
}

// Overview builds the uptime page.
func (s *Service) Overview(ctx context.Context, window string) (model.UptimeOverview, error) {
	w, dur := WindowDuration(window)
	out := model.UptimeOverview{Window: w, Hosts: []model.MonitorView{}, Monitors: []model.MonitorView{}, Incidents: []model.IncidentView{}}
	ms, err := s.monitors(ctx, ``)
	if err != nil {
		return out, err
	}
	wd, err := s.loadWindow(ctx, dur, "")
	if err != nil {
		return out, err
	}
	var all Counts
	latN, latSum := 0, 0.0
	for _, m := range ms {
		v := wd.view(m)
		if m.Type == "host" {
			out.Hosts = append(out.Hosts, v)
		} else {
			out.Monitors = append(out.Monitors, v)
		}
		if !m.Enabled {
			continue
		}
		out.Stats.MonitorsTotal++
		if v.Status == "up" || v.Status == "degraded" {
			out.Stats.MonitorsUp++
		}
		all.Add(wd.totals[m.ID])
		if v.LatencyMs > 0 {
			latN++
			latSum += v.LatencyMs
		}
		out.Stats.Incidents += v.Incidents
	}
	out.Stats.Overall = all.Pct()
	if out.Stats.Overall < 0 {
		out.Stats.Overall = 100
	}
	if latN > 0 {
		out.Stats.AvgLatencyMs = float64(int64(latSum/float64(latN) + 0.5))
	}
	rows, err := s.db.Query(ctx, `SELECT i.id::text, i.monitor_id::text, m.name, coalesce(h.name, ''), m.type, i.status, i.message, i.started_at, i.ended_at
		FROM incidents i JOIN monitors m ON m.id = i.monitor_id LEFT JOIN hosts h ON h.id = m.host_id
		WHERE i.started_at >= now() - interval '30 days' OR i.ended_at IS NULL ORDER BY i.started_at DESC LIMIT 100`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var iv model.IncidentView
		var name, host, typ string
		if err := rows.Scan(&iv.ID, &iv.MonitorID, &name, &host, &typ, &iv.Status, &iv.Message, &iv.StartedAt, &iv.EndedAt); err != nil {
			return out, err
		}
		iv.Target = name
		if host != "" && typ != "host" {
			iv.Target = name + " · " + host
		}
		end := time.Now()
		if iv.EndedAt != nil {
			end = *iv.EndedAt
		} else {
			out.Stats.OpenIncidents++
		}
		iv.DurationSec = int64(end.Sub(iv.StartedAt).Seconds())
		out.Incidents = append(out.Incidents, iv)
	}
	return out, rows.Err()
}

// Public builds the public status page payload.
func (s *Service) Public(ctx context.Context, window string) (model.PublicStatus, error) {
	_, dur := WindowDuration(window)
	out := model.PublicStatus{Title: "Service status", Status: "up", Monitors: []model.PublicMonitor{}}
	ms, err := s.monitors(ctx, `WHERE m.enabled`)
	if err != nil {
		return out, err
	}
	wd, err := s.loadWindow(ctx, dur, "")
	if err != nil {
		return out, err
	}
	var all Counts
	rank := map[string]int{"up": 0, "unknown": 0, "degraded": 1, "down": 2}
	for _, m := range ms {
		v := wd.view(m)
		all.Add(wd.totals[m.ID])
		pct := v.Pct
		if pct < 0 {
			pct = 100
		}
		out.Monitors = append(out.Monitors, model.PublicMonitor{Name: m.Name, Status: v.Status, Pct: pct, Bars: v.Bars})
		if rank[v.Status] > rank[out.Status] {
			out.Status = v.Status
		}
	}
	sort.SliceStable(out.Monitors, func(i, j int) bool { return out.Monitors[i].Name < out.Monitors[j].Name })
	out.Overall = all.Pct()
	if out.Overall < 0 {
		out.Overall = 100
	}
	return out, nil
}
