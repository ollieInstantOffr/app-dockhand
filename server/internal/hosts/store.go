// Package hosts stores Docker hosts and manages SSH / Docker connections to them.
package hosts

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/model"
	"dockhand/internal/secret"
)

var ErrNotFound = errors.New("host not found")

// Record is a host row. The embedded model.Host carries the public fields;
// runtime-only fields (running, spark, …) are filled in by the monitor.
type Record struct {
	model.Host
	PasswordEnc string
	HostKey     string
}

type Store struct {
	db  *db.DB
	box *secret.Box
}

func NewStore(pool *db.DB, box *secret.Box) *Store { return &Store{db: pool, box: box} }

const cols = `id::text, name, address, port, ssh_user, method, coalesce(password_enc, ''), host_key, color, status,
	os, kernel, docker_version, cpu_cores, uptime_sec, cpu, mem_used, mem_total, disk_used, disk_total,
	last_seen_at, last_error, fail_count, monitored, mcp_exposed, created_at`

func scan(row interface{ Scan(...any) error }) (Record, error) {
	var r Record
	h := &r.Host
	err := row.Scan(&h.ID, &h.Name, &h.Address, &h.Port, &h.User, &h.Method, &r.PasswordEnc, &r.HostKey, &h.Color, &h.Status,
		&h.OS, &h.Kernel, &h.DockerVersion, &h.CPUCores, &h.UptimeSec, &h.CPU, &h.MemUsed, &h.MemTotal, &h.DiskUsed, &h.DiskTotal,
		&h.LastSeenAt, &h.LastError, &h.FailCount, &h.Monitored, &h.McpExposed, &h.CreatedAt)
	if err != nil {
		return r, err
	}
	if h.MemTotal > 0 {
		h.Mem = round1(float64(h.MemUsed) / float64(h.MemTotal) * 100)
	}
	if h.DiskTotal > 0 {
		h.Disk = round1(float64(h.DiskUsed) / float64(h.DiskTotal) * 100)
	}
	h.CPU = round1(h.CPU)
	h.Spark = []float64{}
	return r, nil
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }

// List returns all hosts ordered by sort order then name.
func (s *Store) List(ctx context.Context) ([]Record, error) {
	rows, err := s.db.Query(ctx, `SELECT `+cols+` FROM hosts ORDER BY sort_order, lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Get returns a host by id (or by exact name when idOrName is not a UUID).
func (s *Store) Get(ctx context.Context, idOrName string) (Record, error) {
	q := `SELECT ` + cols + ` FROM hosts WHERE id::text = $1 OR name = $1 LIMIT 1`
	r, err := scan(s.db.QueryRow(ctx, q, idOrName))
	if db.IsNoRows(err) {
		return r, ErrNotFound
	}
	return r, err
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// Validate normalises and validates a HostInput.
func Validate(in *model.HostInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Address = strings.TrimSpace(in.Address)
	in.User = strings.TrimSpace(in.User)
	if !nameRe.MatchString(in.Name) {
		return errors.New("name must be 1–63 characters: letters, digits, '.', '_' or '-'")
	}
	switch in.Method {
	case "local":
		if in.Address == "" {
			in.Address = "unix:///var/run/docker.sock"
		}
		if in.User == "" {
			in.User = "root"
		}
		return nil
	case "key", "password":
	case "":
		in.Method = "key"
	default:
		return errors.New("method must be key, password or local")
	}
	if in.Address == "" || strings.ContainsAny(in.Address, " /@") {
		return errors.New("address must be a hostname or IP")
	}
	if in.Port == 0 {
		in.Port = 22
	}
	if in.Port < 1 || in.Port > 65535 {
		return errors.New("port must be 1–65535")
	}
	if in.User == "" {
		in.User = "root"
	}
	return nil
}

// Create inserts a host with status pending.
func (s *Store) Create(ctx context.Context, in model.HostInput) (Record, error) {
	if err := Validate(&in); err != nil {
		return Record{}, err
	}
	var pw any
	if in.Method == "password" {
		if in.Password == "" {
			return Record{}, errors.New("password is required for password authentication")
		}
		enc, err := s.box.Encrypt(in.Password)
		if err != nil {
			return Record{}, err
		}
		pw = enc
	}
	color := in.Color
	if color == "" {
		color = "#2f6fed"
	}
	r, err := scan(s.db.QueryRow(ctx, `INSERT INTO hosts (name, address, port, ssh_user, method, password_enc, color, sort_order)
		VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT coalesce(max(sort_order), 0) + 1 FROM hosts)) RETURNING `+cols,
		in.Name, in.Address, in.Port, in.User, in.Method, pw, color))
	if err != nil && strings.Contains(err.Error(), "hosts_name_key") {
		return r, fmt.Errorf("a host named %q already exists", in.Name)
	}
	return r, err
}

// Patch is the PATCH /api/hosts/:id body.
type Patch struct {
	Name         *string `json:"name"`
	Address      *string `json:"address"`
	Port         *int    `json:"port"`
	User         *string `json:"user"`
	Method       *string `json:"method"`
	Password     *string `json:"password"`
	Color        *string `json:"color"`
	Monitored    *bool   `json:"monitored"`
	McpExposed   *bool   `json:"mcpExposed"`
	ResetHostKey bool    `json:"resetHostKey"`
}

// Update applies a Patch. It reports whether connection settings changed.
func (s *Store) Update(ctx context.Context, id string, p Patch) (Record, bool, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return cur, false, err
	}
	in := model.HostInput{Name: cur.Name, Address: cur.Address, Port: cur.Port, User: cur.User, Method: cur.Method, Color: cur.Color}
	set := func(dst *string, v *string) {
		if v != nil {
			*dst = *v
		}
	}
	set(&in.Name, p.Name)
	set(&in.Address, p.Address)
	set(&in.User, p.User)
	set(&in.Method, p.Method)
	set(&in.Color, p.Color)
	if p.Port != nil {
		in.Port = *p.Port
	}
	if err := Validate(&in); err != nil {
		return cur, false, err
	}
	pwEnc := cur.PasswordEnc
	if p.Password != nil && *p.Password != "" {
		if pwEnc, err = s.box.Encrypt(*p.Password); err != nil {
			return cur, false, err
		}
	}
	if in.Method != "password" {
		pwEnc = ""
	} else if pwEnc == "" {
		return cur, false, errors.New("password is required for password authentication")
	}
	hostKey := cur.HostKey
	connChanged := in.Address != cur.Address || in.Port != cur.Port || in.User != cur.User || in.Method != cur.Method ||
		pwEnc != cur.PasswordEnc || p.ResetHostKey
	if p.ResetHostKey || in.Address != cur.Address || in.Port != cur.Port {
		hostKey = ""
	}
	monitored, mcp := cur.Monitored, cur.McpExposed
	if p.Monitored != nil {
		monitored = *p.Monitored
	}
	if p.McpExposed != nil {
		mcp = *p.McpExposed
	}
	var pw any
	if pwEnc != "" {
		pw = pwEnc
	}
	r, err := scan(s.db.QueryRow(ctx, `UPDATE hosts SET name=$2, address=$3, port=$4, ssh_user=$5, method=$6, password_enc=$7,
		color=$8, host_key=$9, monitored=$10, mcp_exposed=$11 WHERE id = $1 RETURNING `+cols,
		cur.ID, in.Name, in.Address, in.Port, in.User, in.Method, pw, in.Color, hostKey, monitored, mcp))
	if err != nil && strings.Contains(err.Error(), "hosts_name_key") {
		return r, false, fmt.Errorf("a host named %q already exists", in.Name)
	}
	return r, connChanged, err
}

// Delete removes a host (FK cascades clean monitors, metrics, events, stacks, alerts).
func (s *Store) Delete(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM hosts WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PinHostKey stores the host key seen on first connect.
func (s *Store) PinHostKey(ctx context.Context, id, key string) error {
	_, err := s.db.Exec(ctx, `UPDATE hosts SET host_key = $2 WHERE id::text = $1 AND host_key = ''`, id, key)
	return err
}

// Facts are the values refreshed by the poller / host test.
type Facts struct {
	OS, Kernel, DockerVersion string
	CPUCores                  int
	UptimeSec                 int64
	CPU                       float64
	MemUsed, MemTotal         int64
	DiskUsed, DiskTotal       int64
}

// RecordSuccess stores fresh facts and status after a successful poll.
func (s *Store) RecordSuccess(ctx context.Context, id, status string, f Facts) error {
	_, err := s.db.Exec(ctx, `UPDATE hosts SET status=$2, os=CASE WHEN $3 = '' THEN os ELSE $3 END, kernel=CASE WHEN $4 = '' THEN kernel ELSE $4 END,
		docker_version=CASE WHEN $5 = '' THEN docker_version ELSE $5 END, cpu_cores=CASE WHEN $6 = 0 THEN cpu_cores ELSE $6 END,
		uptime_sec=$7, cpu=$8, mem_used=$9, mem_total=$10, disk_used=$11, disk_total=$12,
		last_seen_at=now(), last_error='', fail_count=0 WHERE id::text = $1`,
		id, status, f.OS, f.Kernel, f.DockerVersion, f.CPUCores, f.UptimeSec, f.CPU, f.MemUsed, f.MemTotal, f.DiskUsed, f.DiskTotal)
	return err
}

// RecordFailure increments fail_count and flips status to offline once retries is reached.
// It returns the new fail count and status.
func (s *Store) RecordFailure(ctx context.Context, id, msg string, retries int) (int, string, error) {
	var n int
	var st string
	err := s.db.QueryRow(ctx, `UPDATE hosts SET fail_count = fail_count + 1, last_error = $2,
		status = CASE WHEN fail_count + 1 >= $3 THEN 'offline' ELSE status END
		WHERE id::text = $1 RETURNING fail_count, status`, id, msg, retries).Scan(&n, &st)
	return n, st, err
}

// InsertMetric appends a host_metrics sample.
func (s *Store) InsertMetric(ctx context.Context, id string, cpu, mem, disk float64) error {
	_, err := s.db.Exec(ctx, `INSERT INTO host_metrics (host_id, cpu, mem, disk) VALUES ($1, $2, $3, $4)`, id, cpu, mem, disk)
	return err
}

// Metrics returns samples within the range, downsampled to at most ~180 points.
func (s *Store) Metrics(ctx context.Context, id string, rng time.Duration) ([]model.MetricPoint, error) {
	bucket := int64(rng.Seconds() / 180)
	if bucket < 10 {
		bucket = 10
	}
	rows, err := s.db.Query(ctx, `SELECT to_timestamp(floor(extract(epoch from at) / $3) * $3) AS b,
		avg(cpu), avg(mem), avg(disk) FROM host_metrics WHERE host_id::text = $1 AND at > now() - make_interval(secs => $2)
		GROUP BY b ORDER BY b`, id, rng.Seconds(), bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.MetricPoint{}
	for rows.Next() {
		var p model.MetricPoint
		if err := rows.Scan(&p.At, &p.CPU, &p.Mem, &p.Disk); err != nil {
			return nil, err
		}
		p.CPU, p.Mem, p.Disk = round1(p.CPU), round1(p.Mem), round1(p.Disk)
		out = append(out, p)
	}
	return out, rows.Err()
}

// PruneMetrics deletes samples older than 48 h.
func (s *Store) PruneMetrics(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `DELETE FROM host_metrics WHERE at < now() - interval '48 hours'`)
	return err
}

// SetStatus sets status directly (e.g. after a successful test).
func (s *Store) SetStatus(ctx context.Context, id, status string) error {
	_, err := s.db.Exec(ctx, `UPDATE hosts SET status = $2, fail_count = 0, last_error = '', last_seen_at = now() WHERE id::text = $1`, id, status)
	return err
}

// Count returns the number of hosts.
func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM hosts`).Scan(&n)
	return n, err
}

// SplitHostPort renders address:port for dialing.
func dialAddr(address string, port int) string {
	return net.JoinHostPort(address, fmt.Sprint(port))
}
