// Package settings stores Dockhand's settings sections in the `settings` table
// (one JSON row per section) with an in-memory cache and defaults.
package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"dockhand/internal/db"
)

type General struct {
	PublicURL string `json:"publicUrl"`
	Domain    string `json:"domain"`
}

type Uptime struct {
	IntervalSec  int      `json:"intervalSec"`
	Retries      int      `json:"retries"`
	HostIDs      []string `json:"hostIds"`
	AutoMonitor  bool     `json:"autoMonitor"`
	Notify       bool     `json:"notify"`
	PublicStatus bool     `json:"publicStatus"`
}

// GitHub is the stored github section. SecretEnc holds the encrypted webhook secret.
type GitHub struct {
	AutoDeploy  bool   `json:"autoDeploy"`
	WaitChecks  bool   `json:"waitChecks"`
	OnlyCompose bool   `json:"onlyCompose"`
	SecretEnc   string `json:"secretEnc,omitempty"`
}

type ToolPref struct {
	Enabled bool `json:"enabled"`
	Confirm bool `json:"confirm"`
}

type MCP struct {
	Enabled   bool   `json:"enabled"`
	Transport string `json:"transport"`
	// Port, when non-zero, also serves the MCP endpoint on its own listener
	// (":<port>/mcp"). 0 = only on Dockhand's main port.
	Port  int                 `json:"port"`
	Tools map[string]ToolPref `json:"tools"`
}

type Updates struct {
	Auto           bool   `json:"auto"`
	Channel        string `json:"channel"`
	Window         string `json:"window"`
	Backup         bool   `json:"backup"`
	Build          string `json:"build"`
	RedeployOnPush bool   `json:"redeployOnPush"`
	Repo           string `json:"repo"`
	ComposeFile    string `json:"composeFile"`
}

type Notifications struct {
	HostDown       bool `json:"hostDown"`
	ContainerCrash bool `json:"containerCrash"`
	Unhealthy      bool `json:"unhealthy"`
	Updates        bool `json:"updates"`
	DiskSpace      bool `json:"diskSpace"`
	Deploys        bool `json:"deploys"`
	Digest         bool `json:"digest"`
}

// Settings is the full stored configuration.
type Settings struct {
	General       General       `json:"general"`
	Uptime        Uptime        `json:"uptime"`
	GitHub        GitHub        `json:"github"`
	MCP           MCP           `json:"mcp"`
	Updates       Updates       `json:"updates"`
	Notifications Notifications `json:"notifications"`
}

// Sections lists the section keys stored in the settings table.
var Sections = []string{"general", "uptime", "github", "mcp", "updates", "notifications"}

// ToolInfo describes an MCP tool for default preferences.
type ToolInfo struct {
	Name   string
	Writes bool
}

// Defaults returns the default settings. tools is the MCP catalog.
func Defaults(publicURL string, tools []ToolInfo) Settings {
	tp := map[string]ToolPref{}
	for _, t := range tools {
		tp[t.Name] = ToolPref{Enabled: true, Confirm: t.Writes}
	}
	return Settings{
		General: General{PublicURL: publicURL, Domain: "home.arpa"},
		Uptime:  Uptime{IntervalSec: 60, Retries: 2, HostIDs: []string{}, AutoMonitor: true, Notify: true},
		GitHub:  GitHub{AutoDeploy: true, OnlyCompose: true},
		MCP:     MCP{Transport: "http", Tools: tp},
		Updates: Updates{Channel: "stable", Window: "Sun 03:00–05:00", Backup: true, Build: "pull",
			Repo: "dockhand-app/dockhand", ComposeFile: "/opt/dockhand/docker-compose.yml"},
		Notifications: Notifications{HostDown: true, ContainerCrash: true, Unhealthy: true, Updates: true,
			DiskSpace: true, Deploys: true},
	}
}

// Store caches settings and persists changes.
type Store struct {
	db       *db.DB
	mu       sync.RWMutex
	cur      Settings
	defaults Settings
}

func New(pool *db.DB, defaults Settings) *Store {
	return &Store{db: pool, cur: defaults, defaults: defaults}
}

// Load reads every section from the database, overlaying stored values on the defaults.
func (s *Store) Load(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT key, value FROM settings WHERE key = ANY($1)`, Sections)
	if err != nil {
		return err
	}
	defer rows.Close()
	merged := toMap(s.defaults)
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return err
		}
		var sec map[string]any
		if json.Unmarshal(v, &sec) == nil {
			base, _ := merged[k].(map[string]any)
			merged[k] = deepMerge(base, sec)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var out Settings
	if err := fromMap(merged, &out); err != nil {
		return err
	}
	normalize(&out, s.defaults)
	s.mu.Lock()
	s.cur = out
	s.mu.Unlock()
	return nil
}

// Get returns a copy of the current settings.
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.cur
	c.Uptime.HostIDs = append([]string{}, s.cur.Uptime.HostIDs...)
	c.MCP.Tools = make(map[string]ToolPref, len(s.cur.MCP.Tools))
	for k, v := range s.cur.MCP.Tools {
		c.MCP.Tools[k] = v
	}
	return c
}

// computed keys that are filled on read and never written.
var readOnly = map[string][]string{
	"github": {"webhookUrl", "webhookSecret", "appConfigured", "oauthConfigured", "appInstallUrl", "secretEnc"},
}

// Patch deep-merges a SettingsPatch into the stored settings and persists the changed sections.
func (s *Store) Patch(ctx context.Context, patch map[string]map[string]any) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := toMap(s.cur)
	changed := []string{}
	for sec, vals := range patch {
		base, ok := cur[sec].(map[string]any)
		if !ok {
			return Settings{}, fmt.Errorf("unknown settings section %q", sec)
		}
		for _, k := range readOnly[sec] {
			delete(vals, k)
		}
		cur[sec] = deepMerge(base, vals)
		changed = append(changed, sec)
	}
	var out Settings
	if err := fromMap(cur, &out); err != nil {
		return Settings{}, fmt.Errorf("invalid settings: %w", err)
	}
	if err := validate(&out); err != nil {
		return Settings{}, err
	}
	normalize(&out, s.defaults)
	final := toMap(out)
	for _, sec := range changed {
		if err := s.save(ctx, sec, final[sec]); err != nil {
			return Settings{}, err
		}
	}
	s.cur = out
	return out, nil
}

// Update applies fn to a copy of the settings and persists the given section.
func (s *Store) Update(ctx context.Context, section string, fn func(*Settings)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cur
	fn(&c)
	if err := s.save(ctx, section, toMap(c)[section]); err != nil {
		return err
	}
	s.cur = c
	return nil
}

func (s *Store) save(ctx context.Context, key string, v any) error {
	_, err := s.db.Exec(ctx, `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
		key, db.JSON(v), time.Now())
	return err
}

// GetRaw reads an arbitrary settings row (used for keys outside the sections, e.g. ssh_key).
func (s *Store) GetRaw(ctx context.Context, key string, dst any) (bool, error) {
	var v []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(&v)
	if db.IsNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(v, dst)
}

// PutRaw writes an arbitrary settings row.
func (s *Store) PutRaw(ctx context.Context, key string, v any) error { return s.save(ctx, key, v) }

func validate(s *Settings) error {
	switch s.Uptime.IntervalSec {
	case 30, 60, 300:
	default:
		return fmt.Errorf("uptime.intervalSec must be 30, 60 or 300")
	}
	if s.Uptime.Retries < 1 || s.Uptime.Retries > 3 {
		return fmt.Errorf("uptime.retries must be 1–3")
	}
	switch s.MCP.Transport {
	case "http", "sse":
	default:
		return fmt.Errorf("mcp.transport must be http or sse")
	}
	if s.MCP.Port != 0 && (s.MCP.Port < 1024 || s.MCP.Port > 65535) {
		return fmt.Errorf("mcp.port must be 1024–65535, or 0 to use Dockhand's own port")
	}
	switch s.Updates.Channel {
	case "stable", "beta", "nightly":
	default:
		return fmt.Errorf("updates.channel must be stable, beta or nightly")
	}
	switch s.Updates.Build {
	case "pull", "build":
	default:
		return fmt.Errorf("updates.build must be pull or build")
	}
	s.General.PublicURL = strings.TrimRight(strings.TrimSpace(s.General.PublicURL), "/")
	s.General.Domain = strings.TrimSpace(s.General.Domain)
	return nil
}

func normalize(s *Settings, d Settings) {
	if s.Uptime.HostIDs == nil {
		s.Uptime.HostIDs = []string{}
	}
	if s.MCP.Tools == nil {
		s.MCP.Tools = map[string]ToolPref{}
	}
	for k, v := range d.MCP.Tools {
		if _, ok := s.MCP.Tools[k]; !ok {
			s.MCP.Tools[k] = v
		}
	}
	if s.General.PublicURL == "" {
		s.General.PublicURL = d.General.PublicURL
	}
}

func toMap(s Settings) map[string]any {
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func fromMap(m map[string]any, dst *Settings) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

// deepMerge overlays patch onto base recursively (maps merge, everything else replaces).
func deepMerge(base, patch map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(patch))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range patch {
		if pm, ok := v.(map[string]any); ok {
			if bm, ok := out[k].(map[string]any); ok {
				out[k] = deepMerge(bm, pm)
				continue
			}
		}
		out[k] = v
	}
	return out
}
