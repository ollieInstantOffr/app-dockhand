// Package machines manages the hosts themselves rather than their containers:
// OS facts, package updates, systemd services, listening ports, hardening
// checks, and baselines that hold a group of machines to the same rules.
package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
)

type Service struct {
	db    *db.DB
	hosts *hosts.Store
	conns *hosts.Manager
	jobs  *jobs.Runner

	// Impact returns a host's blast radius; set by main so patch impact can say
	// which containers a Docker restart would stop.
	Impact func(ctx context.Context, hostID string) (model.Impact, error)

	mu      sync.Mutex
	running map[string]bool // hosts being collected right now
}

func New(pool *db.DB, hs *hosts.Store, conns *hosts.Manager, jr *jobs.Runner) *Service {
	return &Service{db: pool, hosts: hs, conns: conns, jobs: jr, running: map[string]bool{}}
}

// ─── Reading ────────────────────────────────────────────────────────────────

const factCols = `host_id::text, os, release, kernel, arch, pkg_manager, uptime_sec, load, temp_c, reboot,
	reboot_pkgs, packages, services, ports, checks, pending, sudo, last_patch_at, apt_update_at, error, collected_at`

func scanFacts(row interface{ Scan(...any) error }) (model.Machine, error) {
	var m model.Machine
	var rebootPkgs, pkgs, svcs, ports, chks, pending []byte
	var collected time.Time
	err := row.Scan(&m.HostID, &m.OS, &m.Release, &m.Kernel, &m.Arch, &m.PkgManager, &m.UptimeSec, &m.Load, &m.TempC,
		&m.Reboot, &rebootPkgs, &pkgs, &svcs, &ports, &chks, &pending, &m.Sudo, &m.LastPatchAt, &m.AptUpdateAt, &m.Error, &collected)
	if err != nil {
		return m, err
	}
	m.CollectedAt = &collected
	_ = json.Unmarshal(rebootPkgs, &m.RebootPkgs)
	_ = json.Unmarshal(pkgs, &m.Packages)
	_ = json.Unmarshal(svcs, &m.Services)
	_ = json.Unmarshal(ports, &m.Ports)
	_ = json.Unmarshal(chks, &m.Checks)
	_ = json.Unmarshal(pending, &m.Pending)
	for _, p := range m.Packages {
		if p.Security {
			m.Security++
		}
	}
	return m, nil
}

func blank(m *model.Machine) {
	if m.RebootPkgs == nil {
		m.RebootPkgs = []string{}
	}
	if m.Packages == nil {
		m.Packages = []model.MachinePackage{}
	}
	if m.Services == nil {
		m.Services = []model.MachineService{}
	}
	if m.Ports == nil {
		m.Ports = []model.MachinePort{}
	}
	if m.Checks == nil {
		m.Checks = []model.MachineCheck{}
	}
	if m.Pending == nil {
		m.Pending = []string{}
	}
	if m.Baselines == nil {
		m.Baselines = []string{}
	}
}

// List returns every host with the facts Dockhand has for it.
func (s *Service) List(ctx context.Context) ([]model.Machine, error) {
	recs, err := s.hosts.List(ctx)
	if err != nil {
		return nil, err
	}
	facts := map[string]model.Machine{}
	rows, err := s.db.Query(ctx, `SELECT `+factCols+` FROM machine_facts`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		m, err := scanFacts(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		facts[m.HostID] = m
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	bases, err := s.baselines(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]model.Machine, 0, len(recs))
	for _, h := range recs {
		m := facts[h.ID]
		m.HostID, m.Name, m.Color, m.Status, m.Method = h.ID, h.Name, h.Color, h.Status, h.Method
		blank(&m)
		byID := map[string]model.MachineCheck{}
		for _, c := range m.Checks {
			byID[c.ID] = c
		}
		for _, b := range bases {
			if !contains(b.HostIDs, h.ID) {
				continue
			}
			m.Baselines = append(m.Baselines, b.Name)
			for _, r := range b.Rules {
				if c, ok := byID[r]; ok && (c.Status == "bad" || c.Status == "warn") {
					m.Drift++
				}
			}
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

// Get returns one machine, collecting facts first when asked (or when there are none yet).
func (s *Service) Get(ctx context.Context, hostID string, refresh bool) (model.Machine, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.Machine{}, err
	}
	m, err := scanFacts(s.db.QueryRow(ctx, `SELECT `+factCols+` FROM machine_facts WHERE host_id::text = $1`, rec.ID))
	stale := db.IsNoRows(err)
	if err != nil && !stale {
		return model.Machine{}, err
	}
	if refresh || stale {
		if c, cerr := s.Collect(ctx, rec.ID); cerr == nil {
			m = c
		} else if stale {
			return model.Machine{}, cerr
		}
	}
	m.HostID, m.Name, m.Color, m.Status, m.Method = rec.ID, rec.Name, rec.Color, rec.Status, rec.Method
	blank(&m)
	return m, nil
}

// ─── Collecting ─────────────────────────────────────────────────────────────

// Collect runs the fact script on a machine and stores what it finds.
func (s *Service) Collect(ctx context.Context, hostID string) (model.Machine, error) {
	s.mu.Lock()
	if s.running[hostID] {
		s.mu.Unlock()
		return model.Machine{}, &dockerops.BadRequest{Msg: "already collecting facts for this machine"}
	}
	s.running[hostID] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, hostID)
		s.mu.Unlock()
	}()

	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return model.Machine{}, err
	}
	cctx, cancel := ctxTimeout(ctx, 90*time.Second)
	defer cancel()
	conn, err := s.conns.Get(cctx, rec.ID)
	if err != nil {
		s.saveError(rec.ID, err)
		return model.Machine{}, err
	}
	res, err := conn.HostExec(cctx, collectScript)
	if err != nil && strings.TrimSpace(res.Stdout) == "" {
		s.saveError(rec.ID, err)
		return model.Machine{}, fmt.Errorf("couldn't read %s: %w", rec.Name, err)
	}
	m := parse(res.Stdout)
	m.Checks = checks(res.Stdout, &m, rec.Method)
	m.HostID, m.Name, m.Color, m.Status, m.Method = rec.ID, rec.Name, rec.Color, rec.Status, rec.Method
	if !isRoot(res.Stdout) && !m.Sudo {
		m.Error = "Dockhand's SSH user can't run sudo without a password, so updates and fixes aren't available."
	}
	blank(&m)
	if err := s.save(ctx, m); err != nil {
		return m, err
	}
	return m, nil
}

func (s *Service) save(ctx context.Context, m model.Machine) error {
	j := func(v any) []byte {
		b, _ := json.Marshal(v)
		return b
	}
	_, err := s.db.Exec(ctx, `INSERT INTO machine_facts (host_id, os, release, kernel, arch, pkg_manager, uptime_sec, load,
		temp_c, reboot, reboot_pkgs, packages, services, ports, checks, pending, sudo, last_patch_at, apt_update_at, error, collected_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now())
		ON CONFLICT (host_id) DO UPDATE SET os = EXCLUDED.os, release = EXCLUDED.release, kernel = EXCLUDED.kernel,
		arch = EXCLUDED.arch, pkg_manager = EXCLUDED.pkg_manager, uptime_sec = EXCLUDED.uptime_sec, load = EXCLUDED.load,
		temp_c = EXCLUDED.temp_c, reboot = EXCLUDED.reboot, reboot_pkgs = EXCLUDED.reboot_pkgs, packages = EXCLUDED.packages,
		services = EXCLUDED.services, ports = EXCLUDED.ports, checks = EXCLUDED.checks, pending = EXCLUDED.pending, sudo = EXCLUDED.sudo,
		last_patch_at = EXCLUDED.last_patch_at, apt_update_at = EXCLUDED.apt_update_at, error = EXCLUDED.error,
		collected_at = now()`,
		m.HostID, m.OS, m.Release, m.Kernel, m.Arch, m.PkgManager, m.UptimeSec, m.Load, m.TempC, m.Reboot,
		j(m.RebootPkgs), j(m.Packages), j(m.Services), j(m.Ports), j(m.Checks), j(m.Pending), m.Sudo, m.LastPatchAt, m.AptUpdateAt, m.Error)
	return err
}

func (s *Service) saveError(hostID string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := err.Error()
	if len(msg) > 400 {
		msg = msg[:400]
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO machine_facts (host_id, error) VALUES ($1::uuid, $2)
		ON CONFLICT (host_id) DO UPDATE SET error = EXCLUDED.error, collected_at = now()`, hostID, msg)
}

// Run refreshes facts for every online host on a slow loop.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(30 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(45 * time.Second):
		}
		s.collectAll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) collectAll(ctx context.Context) {
	recs, err := s.hosts.List(ctx)
	if err != nil {
		return
	}
	for _, h := range recs {
		if h.Status == "offline" || h.Status == "pending" {
			continue
		}
		if _, err := s.Collect(ctx, h.ID); err != nil {
			slog.Debug("machine facts", "host", h.Name, "err", err)
		}
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

// run executes a privileged command on a machine, streaming it into a job.
func (s *Service) run(ctx context.Context, j *jobs.Job, hostID, cmd string) error {
	conn, err := s.conns.Get(ctx, hostID)
	if err != nil {
		return err
	}
	res, err := conn.HostExec(ctx, "id -u")
	root := err == nil && strings.TrimSpace(res.Stdout) == "0"
	full := withSudo(cmd, root)
	j.Log("cmd", "$ "+cmd)
	code, err := conn.HostExecStream(ctx, full, func(stream, line string) {
		level := "info"
		if stream == "stderr" {
			level = "muted"
			low := strings.ToLower(line)
			if strings.Contains(low, "error") || strings.Contains(low, "failed") {
				level = "error"
			}
		}
		j.Log(level, line)
	})
	if err != nil {
		return err
	}
	if code != 0 {
		if !root {
			return fmt.Errorf("command exited with status %d (Dockhand's SSH user may need passwordless sudo)", code)
		}
		return fmt.Errorf("command exited with status %d", code)
	}
	return nil
}

// AptUpdate refreshes the package lists (job).
func (s *Service) AptUpdate(ctx context.Context, hostID, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: "apt update on " + rec.Name, HostID: rec.ID, Actor: actor,
		Plan: []string{"Refreshing package lists", "Reading packages"}},
		func(ctx context.Context, j *jobs.Job) error {
			j.Step("Refreshing package lists", "apt-get update")
			if err := s.run(ctx, j, rec.ID, "apt-get update"); err != nil {
				return err
			}
			j.Step("Reading packages", "")
			m, err := s.Collect(ctx, rec.ID)
			if err != nil {
				return err
			}
			j.Logf("ok", "%d update(s) available, %d security", len(m.Packages), m.Security)
			j.Set("packages", len(m.Packages))
			return nil
		})
}

// Install upgrades the named packages, or every security update when securityOnly is set (job).
func (s *Service) Install(ctx context.Context, hostID string, pkgs []string, securityOnly bool, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	m, err := s.Get(ctx, hostID, false)
	if err != nil {
		return "", err
	}
	if m.PkgManager != "apt" {
		return "", &dockerops.BadRequest{Msg: "Dockhand can only install updates on apt-based machines (Debian, Ubuntu, Raspberry Pi OS)"}
	}
	var names []string
	if securityOnly {
		for _, p := range m.Packages {
			if p.Security {
				names = append(names, p.Name)
			}
		}
	} else if len(pkgs) > 0 {
		valid := map[string]bool{}
		for _, p := range m.Packages {
			valid[p.Name] = true
		}
		for _, p := range pkgs {
			if !valid[p] {
				return "", &dockerops.BadRequest{Msg: fmt.Sprintf("%s isn't in the list of pending updates — run apt update first", p)}
			}
			names = append(names, p)
		}
	} else {
		for _, p := range m.Packages {
			names = append(names, p.Name)
		}
	}
	if len(names) == 0 {
		return "", &dockerops.BadRequest{Msg: "nothing to install"}
	}
	title := fmt.Sprintf("Install %d update%s on %s", len(names), plural(len(names)), rec.Name)
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: title, HostID: rec.ID, Actor: actor,
		Plan: []string{"Installing packages", "Reading packages"}},
		func(ctx context.Context, j *jobs.Job) error {
			j.Step("Installing packages", strings.Join(names, " "))
			quoted := make([]string, len(names))
			for i, n := range names {
				quoted[i] = shQuote(n)
			}
			cmd := "DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold " + strings.Join(quoted, " ")
			if err := s.run(ctx, j, rec.ID, cmd); err != nil {
				return err
			}
			j.Step("Reading packages", "")
			after, err := s.Collect(ctx, rec.ID)
			if err == nil {
				j.Logf("ok", "%d update(s) left", len(after.Packages))
				if after.Reboot {
					j.Log("warn", "a reboot is needed to finish these updates")
				}
			}
			return nil
		})
}

// Fix applies one hardening check's fix (job).
func (s *Service) Fix(ctx context.Context, hostID, checkID, actor string) (string, error) {
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	m, err := s.Get(ctx, hostID, false)
	if err != nil {
		return "", err
	}
	if checkID == "security-updates" {
		return s.Install(ctx, hostID, nil, true, actor)
	}
	cmd, _ := fixCommand(checkID, m)
	if cmd == "" {
		return "", &dockerops.BadRequest{Msg: "Dockhand can't fix that check automatically"}
	}
	var title string
	for _, c := range m.Checks {
		if c.ID == checkID {
			title = c.Title
		}
	}
	if title == "" {
		title = checkID
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: title + " on " + rec.Name, HostID: rec.ID, Actor: actor,
		Plan: []string{"Applying", "Re-checking"}},
		func(ctx context.Context, j *jobs.Job) error {
			j.Step("Applying", checkID)
			if err := s.run(ctx, j, rec.ID, cmd); err != nil {
				return err
			}
			if checkID == "reboot" {
				j.Log("ok", "reboot started — the machine comes back in a minute or two")
				return nil
			}
			j.Step("Re-checking", "")
			after, err := s.Collect(ctx, rec.ID)
			if err != nil {
				return nil // the fix worked; the re-check can wait for the next poll
			}
			for _, c := range after.Checks {
				if c.ID == checkID {
					j.Logf(map[bool]string{true: "ok", false: "warn"}[c.Status == "ok"], "%s: %s", c.Title, c.Sub)
				}
			}
			return nil
		})
}

// ServiceAction starts, stops or restarts a systemd unit (job).
func (s *Service) ServiceAction(ctx context.Context, hostID, unit, action, actor string) (string, error) {
	switch action {
	case "start", "stop", "restart":
	default:
		return "", &dockerops.BadRequest{Msg: "action must be start, stop or restart"}
	}
	if unit == "" || strings.ContainsAny(unit, " ;&|$`") {
		return "", &dockerops.BadRequest{Msg: "invalid unit name"}
	}
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: upper1(action) + " " + unit + " on " + rec.Name, HostID: rec.ID, Actor: actor,
		Plan: []string{"Running systemctl", "Reading services"}},
		func(ctx context.Context, j *jobs.Job) error {
			j.Step("Running systemctl", "systemctl "+action+" "+unit)
			if err := s.run(ctx, j, rec.ID, "systemctl "+action+" "+shQuote(unit)+" && systemctl is-active "+shQuote(unit)+" || true"); err != nil {
				return err
			}
			j.Step("Reading services", "")
			_, _ = s.Collect(ctx, rec.ID)
			return nil
		})
}

// FleetAction runs apt update, a security-only upgrade or a full upgrade everywhere (job).
func (s *Service) FleetAction(ctx context.Context, action, actor string) (string, error) {
	recs, err := s.hosts.List(ctx)
	if err != nil {
		return "", err
	}
	var targets []hosts.Record
	for _, h := range recs {
		if h.Status != "offline" && h.Status != "pending" {
			targets = append(targets, h)
		}
	}
	if len(targets) == 0 {
		return "", &dockerops.BadRequest{Msg: "no machines are reachable"}
	}
	titles := map[string]string{"audit": "Security audit", "security": "Install security patches", "all": "Patch all machines"}
	title, ok := titles[action]
	if !ok {
		return "", &dockerops.BadRequest{Msg: "unknown action"}
	}
	plan := make([]string, 0, len(targets))
	for _, h := range targets {
		plan = append(plan, h.Name)
	}
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: fmt.Sprintf("%s on %d machine%s", title, len(targets), plural(len(targets))), Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error {
			failed := 0
			for _, h := range targets {
				j.Step(h.Name, "")
				var err error
				switch action {
				case "audit":
					var m model.Machine
					m, err = s.Collect(ctx, h.ID)
					if err == nil {
						bad := 0
						for _, c := range m.Checks {
							if c.Status == "bad" {
								bad++
							}
						}
						j.Logf(map[bool]string{true: "ok", false: "warn"}[bad == 0], "%s: %d update(s), %d security, %d check(s) failing", h.Name, len(m.Packages), m.Security, bad)
					}
				case "security":
					err = s.upgrade(ctx, j, h, true)
				case "all":
					err = s.upgrade(ctx, j, h, false)
				}
				if err != nil {
					failed++
					j.Fail(h.Name)
					j.Logf("error", "%s: %s", h.Name, err)
					continue
				}
				j.Done(h.Name)
			}
			if failed > 0 {
				return fmt.Errorf("%d of %d machines failed", failed, len(targets))
			}
			return nil
		})
}

// upgrade installs updates on one machine inside a fleet job.
func (s *Service) upgrade(ctx context.Context, j *jobs.Job, h hosts.Record, securityOnly bool) error {
	m, err := s.Collect(ctx, h.ID)
	if err != nil {
		return err
	}
	if m.PkgManager != "apt" {
		j.Logf("muted", "%s: not an apt machine — skipped", h.Name)
		return nil
	}
	var names []string
	for _, p := range m.Packages {
		if !securityOnly || p.Security {
			names = append(names, shQuote(p.Name))
		}
	}
	if len(names) == 0 {
		j.Logf("ok", "%s: already up to date", h.Name)
		return nil
	}
	cmd := "DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold " + strings.Join(names, " ")
	if err := s.run(ctx, j, h.ID, cmd); err != nil {
		return err
	}
	after, _ := s.Collect(ctx, h.ID)
	j.Logf("ok", "%s: installed %d update(s), %d left", h.Name, len(names), len(after.Packages))
	return nil
}

// ─── Baselines ──────────────────────────────────────────────────────────────

func (s *Service) baselines(ctx context.Context) ([]model.Baseline, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, name, description, color, rules, host_ids, created_at FROM baselines ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Baseline{}
	for rows.Next() {
		var b model.Baseline
		var rules, hostIDs []byte
		if err := rows.Scan(&b.ID, &b.Name, &b.Description, &b.Color, &rules, &hostIDs, &b.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(rules, &b.Rules)
		_ = json.Unmarshal(hostIDs, &b.HostIDs)
		if b.Rules == nil {
			b.Rules = []string{}
		}
		if b.HostIDs == nil {
			b.HostIDs = []string{}
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Baselines returns every baseline with its compliance matrix filled in.
func (s *Service) Baselines(ctx context.Context) ([]model.Baseline, error) {
	list, err := s.baselines(ctx)
	if err != nil {
		return nil, err
	}
	machines, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]model.Machine{}
	for _, m := range machines {
		byID[m.HostID] = m
	}
	for i := range list {
		s.fillCompliance(&list[i], byID)
	}
	return list, nil
}

func (s *Service) fillCompliance(b *model.Baseline, machines map[string]model.Machine) {
	b.Compliance = []model.BaselineRow{}
	total, ok := 0, 0
	for _, hid := range b.HostIDs {
		m, found := machines[hid]
		if !found {
			continue
		}
		row := model.BaselineRow{HostID: hid, Name: m.Name, Color: m.Color, Status: m.Status, Cells: map[string]string{}}
		checks := map[string]model.MachineCheck{}
		for _, c := range m.Checks {
			checks[c.ID] = c
		}
		for _, r := range b.Rules {
			st := "unknown"
			if c, has := checks[r]; has {
				st = c.Status
			}
			row.Cells[r] = st
			switch st { // rules Dockhand couldn't determine don't count either way
			case "ok":
				total++
				ok++
			case "bad", "warn":
				total++
				row.Drift++
			}
		}
		b.Drift += row.Drift
		b.Compliance = append(b.Compliance, row)
	}
	if total > 0 {
		b.Pct = ok * 100 / total
	}
}

func (s *Service) CreateBaseline(ctx context.Context, in model.BaselineInput) (model.Baseline, error) {
	if err := validBaseline(&in); err != nil {
		return model.Baseline{}, err
	}
	var b model.Baseline
	rules, _ := json.Marshal(in.Rules)
	hostIDs, _ := json.Marshal(in.HostIDs)
	err := s.db.QueryRow(ctx, `INSERT INTO baselines (name, description, color, rules, host_ids) VALUES ($1,$2,$3,$4,$5)
		RETURNING id::text, name, description, color, created_at`, in.Name, in.Description, in.Color, rules, hostIDs).
		Scan(&b.ID, &b.Name, &b.Description, &b.Color, &b.CreatedAt)
	b.Rules, b.HostIDs = in.Rules, in.HostIDs
	b.Compliance = []model.BaselineRow{}
	return b, err
}

func (s *Service) UpdateBaseline(ctx context.Context, id string, in model.BaselineInput) (model.Baseline, error) {
	if err := validBaseline(&in); err != nil {
		return model.Baseline{}, err
	}
	rules, _ := json.Marshal(in.Rules)
	hostIDs, _ := json.Marshal(in.HostIDs)
	tag, err := s.db.Exec(ctx, `UPDATE baselines SET name=$2, description=$3, color=$4, rules=$5, host_ids=$6 WHERE id::text=$1`,
		id, in.Name, in.Description, in.Color, rules, hostIDs)
	if err != nil {
		return model.Baseline{}, err
	}
	if tag.RowsAffected() == 0 {
		return model.Baseline{}, dockerops.ErrNotFound
	}
	list, err := s.Baselines(ctx)
	if err != nil {
		return model.Baseline{}, err
	}
	for _, b := range list {
		if b.ID == id {
			return b, nil
		}
	}
	return model.Baseline{}, dockerops.ErrNotFound
}

func (s *Service) DeleteBaseline(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM baselines WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return dockerops.ErrNotFound
	}
	return nil
}

// ApplyBaseline fixes every failing rule on every machine in a baseline (job).
func (s *Service) ApplyBaseline(ctx context.Context, id, actor string) (string, error) {
	list, err := s.Baselines(ctx)
	if err != nil {
		return "", err
	}
	var b *model.Baseline
	for i := range list {
		if list[i].ID == id {
			b = &list[i]
		}
	}
	if b == nil {
		return "", dockerops.ErrNotFound
	}
	type task struct {
		hostID, host, rule string
	}
	var tasks []task
	for _, row := range b.Compliance {
		if row.Status == "offline" || row.Status == "pending" {
			continue
		}
		for rule, st := range row.Cells {
			if st == "bad" || st == "warn" {
				if cmd, _ := fixCommand(rule, model.Machine{}); cmd != "" || rule == "security-updates" {
					tasks = append(tasks, task{row.HostID, row.Name, rule})
				}
			}
		}
	}
	if len(tasks) == 0 {
		return "", &dockerops.BadRequest{Msg: "nothing to fix — every machine already matches this baseline"}
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].host < tasks[j].host })
	plan := make([]string, 0, len(tasks))
	for _, t := range tasks {
		plan = append(plan, t.host+" · "+t.rule)
	}
	name := b.Name
	return s.jobs.Start(jobs.Spec{Kind: "update", Title: "Apply " + name + " to " + fmt.Sprintf("%d machine%s", len(b.Compliance), plural(len(b.Compliance))), Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error {
			failed := 0
			for _, t := range tasks {
				label := t.host + " · " + t.rule
				j.Step(label, "")
				m, err := s.Get(ctx, t.hostID, false)
				if err != nil {
					failed++
					j.Fail(label)
					continue
				}
				cmd := ""
				if t.rule == "security-updates" {
					var names []string
					for _, p := range m.Packages {
						if p.Security {
							names = append(names, shQuote(p.Name))
						}
					}
					if len(names) > 0 {
						cmd = "DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade -o Dpkg::Options::=--force-confold " + strings.Join(names, " ")
					}
				} else {
					cmd, _ = fixCommand(t.rule, m)
				}
				if cmd == "" {
					j.Done(label)
					continue
				}
				if err := s.run(ctx, j, t.hostID, cmd); err != nil {
					failed++
					j.Fail(label)
					j.Logf("error", "%s: %s", label, err)
					continue
				}
				j.Done(label)
			}
			for _, row := range b.Compliance {
				_, _ = s.Collect(ctx, row.HostID)
			}
			if failed > 0 {
				return fmt.Errorf("%d of %d fixes failed", failed, len(tasks))
			}
			return nil
		})
}

func validBaseline(in *model.BaselineInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	if in.Name == "" {
		return &dockerops.BadRequest{Msg: "give the baseline a name"}
	}
	if in.Color == "" {
		in.Color = "#2f6fed"
	}
	if in.Rules == nil {
		in.Rules = []string{}
	}
	if in.HostIDs == nil {
		in.HostIDs = []string{}
	}
	known := map[string]bool{}
	for _, r := range RuleTitles {
		known[r.ID] = true
	}
	for _, r := range in.Rules {
		if !known[r] {
			return &dockerops.BadRequest{Msg: "unknown rule " + r}
		}
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func upper1(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
