// Package stacks manages Docker Compose projects on hosts: discovery from
// container labels, the `stacks` table, compose file I/O and actions.
package stacks

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/monitor"
	"dockhand/internal/util"
)

var ErrNotFound = errors.New("stack not found")

// Row is a stacks table row.
type Row struct {
	ID           string
	HostID       string
	Name         string
	Path         string
	ComposeFile  string // relative to Path, or absolute
	Source       string
	AccountID    *string
	Repo         string
	Branch       string
	SHA          string
	AutoDeploy   bool
	Env          []model.KV
	LastDeployAt *time.Time
}

// ComposePath returns the absolute compose file path.
func (r Row) ComposePath() string {
	if path.IsAbs(r.ComposeFile) {
		return r.ComposeFile
	}
	return path.Join(r.Path, r.ComposeFile)
}

// GitRedeployFunc re-fetches a git stack at its branch head (set by gitdeploy).
type GitRedeployFunc func(ctx context.Context, j *jobs.Job, r Row) error

type Service struct {
	cfg   *config.Config
	db    *db.DB
	hosts *hosts.Store
	conns *hosts.Manager
	mon   *monitor.Monitor
	jobs  *jobs.Runner

	GitRedeploy GitRedeployFunc

	svcMu    sync.Mutex
	services map[string][]model.ComposeServiceInfo // hostID/name → services from the last read compose file
}

func New(cfg *config.Config, pool *db.DB, hs *hosts.Store, conns *hosts.Manager, mon *monitor.Monitor, jr *jobs.Runner) *Service {
	return &Service{cfg: cfg, db: pool, hosts: hs, conns: conns, mon: mon, jobs: jr, services: map[string][]model.ComposeServiceInfo{}}
}

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ValidName checks a compose project name.
func ValidName(n string) error {
	if !nameRe.MatchString(n) {
		return errors.New("stack name must be lowercase letters, digits, '-' or '_' (max 63), starting with a letter or digit")
	}
	return nil
}

const rowCols = `id::text, host_id::text, name, path, compose_file, source, git_account_id::text, coalesce(repo_full_name, ''),
	coalesce(branch, ''), coalesce(sha, ''), auto_deploy, env, last_deploy_at`

func scanRow(row interface{ Scan(...any) error }) (Row, error) {
	var r Row
	var env []byte
	err := row.Scan(&r.ID, &r.HostID, &r.Name, &r.Path, &r.ComposeFile, &r.Source, &r.AccountID, &r.Repo, &r.Branch, &r.SHA,
		&r.AutoDeploy, &env, &r.LastDeployAt)
	if err == nil {
		_ = json.Unmarshal(env, &r.Env)
		r.Env = util.NZ(r.Env)
	}
	return r, err
}

// Rows returns stack rows (optionally for one host).
func (s *Service) Rows(ctx context.Context, hostID string) ([]Row, error) {
	q := `SELECT ` + rowCols + ` FROM stacks`
	args := []any{}
	if hostID != "" {
		q += ` WHERE host_id::text = $1`
		args = append(args, hostID)
	}
	rows, err := s.db.Query(ctx, q+` ORDER BY name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Row loads one stack row.
func (s *Service) Row(ctx context.Context, hostID, name string) (Row, error) {
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM stacks WHERE host_id::text = $1 AND name = $2`, hostID, name))
	if db.IsNoRows(err) {
		return r, ErrNotFound
	}
	return r, err
}

// RowsByRepo returns git stacks deploying a repository.
func (s *Service) RowsByRepo(ctx context.Context, fullName string) ([]Row, error) {
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+` FROM stacks WHERE source = 'git' AND lower(repo_full_name) = lower($1)`, fullName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Upsert saves a stack row, returning its id.
func (s *Service) Upsert(ctx context.Context, r Row) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO stacks (host_id, name, path, compose_file, source, git_account_id, repo_full_name, branch, sha, auto_deploy, env, last_deploy_at)
		VALUES ($1, $2, $3, $4, $5, $6, nullif($7, ''), nullif($8, ''), nullif($9, ''), $10, $11, $12)
		ON CONFLICT (host_id, name) DO UPDATE SET path=EXCLUDED.path, compose_file=EXCLUDED.compose_file, source=EXCLUDED.source,
		git_account_id=EXCLUDED.git_account_id, repo_full_name=EXCLUDED.repo_full_name, branch=EXCLUDED.branch, sha=EXCLUDED.sha,
		auto_deploy=EXCLUDED.auto_deploy, env=EXCLUDED.env, last_deploy_at=coalesce(EXCLUDED.last_deploy_at, stacks.last_deploy_at)
		RETURNING id::text`,
		r.HostID, r.Name, r.Path, r.ComposeFile, r.Source, r.AccountID, r.Repo, r.Branch, r.SHA, r.AutoDeploy, db.JSON(util.NZ(r.Env)), r.LastDeployAt).Scan(&id)
	return id, err
}

func (s *Service) touchDeploy(ctx context.Context, id string) {
	_, _ = s.db.Exec(ctx, `UPDATE stacks SET last_deploy_at = now() WHERE id::text = $1`, id)
}

// List merges managed stacks with projects discovered from container labels.
func (s *Service) List(ctx context.Context, hostID string) ([]model.Stack, error) {
	if _, err := s.hosts.Get(ctx, hostID); err != nil {
		return nil, err
	}
	rows, err := s.Rows(ctx, hostID)
	if err != nil {
		return nil, err
	}
	if !s.mon.HasCache(hostID) {
		s.mon.Refresh(ctx, hostID)
	}
	byProject := map[string][]model.Container{}
	for _, c := range s.mon.Containers(hostID) {
		if c.Stack != "" {
			byProject[c.Stack] = append(byProject[c.Stack], c)
		}
	}
	out := []model.Stack{}
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.Name] = true
		id := r.ID
		st := model.Stack{ID: &id, HostID: hostID, Name: r.Name, Path: r.Path, ComposeFile: r.ComposePath(), Managed: true,
			Source: r.Source, Repo: r.Repo, Branch: r.Branch, SHA: shortSHA(r.SHA), AutoDeploy: r.AutoDeploy, LastDeployAt: r.LastDeployAt}
		st.Services = s.services_(hostID, r.Name, byProject[r.Name])
		st.Status = status(st.Services)
		out = append(out, st)
	}
	for name, ctrs := range byProject {
		if seen[name] {
			continue
		}
		l := ctrs[0].Labels
		wd := l["com.docker.compose.project.working_dir"]
		cf := strings.Split(l["com.docker.compose.project.config_files"], ",")[0]
		st := model.Stack{HostID: hostID, Name: name, Path: wd, ComposeFile: cf, Managed: false, Source: "discovered"}
		st.Services = s.services_(hostID, name, ctrs)
		st.Status = status(st.Services)
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

func (s *Service) services_(hostID, name string, ctrs []model.Container) []model.StackService {
	out := []model.StackService{}
	seen := map[string]bool{}
	sort.Slice(ctrs, func(i, j int) bool { return ctrs[i].Name < ctrs[j].Name })
	for _, c := range ctrs {
		svc := c.Service
		if svc == "" {
			svc = c.Name
		}
		seen[svc] = true
		out = append(out, model.StackService{Name: svc, Image: c.Image, State: c.State, ContainerID: c.ID,
			Ports: util.NZ(c.Ports), Health: c.Health})
	}
	s.svcMu.Lock()
	known := s.services[hostID+"/"+name]
	s.svcMu.Unlock()
	for _, k := range known {
		if !seen[k.Name] {
			out = append(out, model.StackService{Name: k.Name, Image: k.Image, State: "missing", Ports: []model.PortMap{}, Health: "none"})
		}
	}
	return out
}

func status(svcs []model.StackService) string {
	running, total := 0, 0
	for _, s := range svcs {
		total++
		if s.State == "running" {
			running++
		}
	}
	switch {
	case total > 0 && running == total:
		return "running"
	case running > 0:
		return "partial"
	}
	return "stopped"
}

func (s *Service) remember(hostID, name, content string) {
	v := Validate(content)
	if !v.OK {
		return
	}
	s.svcMu.Lock()
	s.services[hostID+"/"+name] = v.Services
	s.svcMu.Unlock()
}

// locate returns the stack row, or a synthetic row for a discovered project.
func (s *Service) locate(ctx context.Context, hostID, name string) (Row, bool, error) {
	r, err := s.Row(ctx, hostID, name)
	if err == nil {
		return r, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return r, false, err
	}
	if !s.mon.HasCache(hostID) {
		s.mon.Refresh(ctx, hostID)
	}
	for _, c := range s.mon.Containers(hostID) {
		if c.Stack == name {
			wd := c.Labels["com.docker.compose.project.working_dir"]
			files := c.Labels["com.docker.compose.project.config_files"]
			cf := strings.Split(files, ",")[0]
			return Row{HostID: hostID, Name: name, Path: wd, ComposeFile: cf, Source: "discovered", Env: []model.KV{}}, false, nil
		}
	}
	return Row{}, false, ErrNotFound
}

// ComposeFile is the GET compose response.
type ComposeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// GetCompose reads a stack's compose file from the host.
func (s *Service) GetCompose(ctx context.Context, hostID, name string) (ComposeFile, error) {
	r, _, err := s.locate(ctx, hostID, name)
	if err != nil {
		return ComposeFile{}, err
	}
	p := r.ComposePath()
	if p == "" {
		return ComposeFile{}, errors.New("this stack's compose file location is unknown")
	}
	conn, err := s.conn(ctx, hostID)
	if err != nil {
		return ComposeFile{}, err
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := conn.Exec(rctx, "cat "+util.Shq(p), nil)
	if err != nil {
		return ComposeFile{}, fmt.Errorf("read %s: %w", p, err)
	}
	s.remember(hostID, name, res.Stdout)
	return ComposeFile{Path: p, Content: res.Stdout}, nil
}

func (s *Service) conn(ctx context.Context, hostID string) (*hosts.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	c, err := s.conns.Get(dctx, hostID)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to host: %w", err)
	}
	return c, nil
}

// WriteFile writes content to a file on the host (via base64 on stdin), creating directories.
func WriteFile(ctx context.Context, conn *hosts.Conn, file string, content []byte) error {
	dir := path.Dir(file)
	tmp := file + ".dockhand-tmp"
	cmd := "mkdir -p " + util.Shq(dir) + " && base64 -d > " + util.Shq(tmp) + " && mv -f " + util.Shq(tmp) + " " + util.Shq(file)
	enc := base64.StdEncoding.EncodeToString(content)
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := conn.Exec(wctx, cmd, strings.NewReader(enc))
	if err != nil {
		return fmt.Errorf("write %s: %w", file, err)
	}
	return nil
}

// ComposeCmd builds "cd <dir> && docker compose -p <name> -f <file> <args>".
func ComposeCmd(r Row, args string) string {
	cd := ""
	if r.Path != "" {
		cd = "cd " + util.Shq(r.Path) + " && "
	}
	files := ""
	if r.ComposeFile != "" {
		files = " -f " + util.Shq(r.ComposePath())
	}
	return cd + "docker compose -p " + util.Shq(r.Name) + files + " " + args
}

// Create writes a new stack under StacksDir and brings it up (job).
func (s *Service) Create(ctx context.Context, hostID, name, content, actor string) (string, error) {
	name = strings.TrimSpace(name)
	if err := ValidName(name); err != nil {
		return "", &dockerops.BadRequest{Msg: err.Error()}
	}
	if v := Validate(content); !v.OK {
		return "", &dockerops.BadRequest{Msg: v.Error}
	}
	if _, err := s.Row(ctx, hostID, name); err == nil {
		return "", &dockerops.BadRequest{Msg: fmt.Sprintf("a stack named %q already exists on this host", name)}
	}
	for _, c := range s.mon.Containers(hostID) {
		if c.Stack == name {
			return "", &dockerops.BadRequest{Msg: fmt.Sprintf("a compose project named %q is already running on this host", name)}
		}
	}
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	r := Row{HostID: hostID, Name: name, Path: s.cfg.StacksDir + "/" + name, ComposeFile: "docker-compose.yml", Source: "manual", Env: []model.KV{}}
	return s.jobs.Start(jobs.Spec{Kind: "compose", Title: fmt.Sprintf("Create stack %s on %s", name, rec.Name), HostID: hostID, Actor: actor,
		Plan: []string{"Writing compose file", "Starting stack", "Saving stack"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			j.Step("Writing compose file", r.ComposePath())
			if err := WriteFile(ctx, conn, r.ComposePath(), []byte(content)); err != nil {
				return err
			}
			s.remember(hostID, name, content)
			j.Step("Starting stack", "docker compose up -d")
			if err := dockerops.RunLogged(ctx, conn, j, ComposeCmd(r, "up -d --remove-orphans")); err != nil {
				return err
			}
			j.Step("Saving stack", "")
			now := time.Now()
			r.LastDeployAt = &now
			id, err := s.Upsert(context.Background(), r)
			if err != nil {
				return err
			}
			j.SetStack(id)
			j.Set("stack", name)
			s.mon.Refresh(context.Background(), hostID)
			return nil
		})
}

// PutCompose validates, writes and applies a new compose file (job).
func (s *Service) PutCompose(ctx context.Context, hostID, name, content, actor string) (string, error) {
	if v := Validate(content); !v.OK {
		msg := v.Error
		if v.Line > 0 {
			msg = fmt.Sprintf("line %d: %s", v.Line, v.Error)
		}
		return "", &dockerops.BadRequest{Msg: msg}
	}
	r, managed, err := s.locate(ctx, hostID, name)
	if err != nil {
		return "", err
	}
	if r.ComposePath() == "" {
		return "", &dockerops.BadRequest{Msg: "this stack's compose file location is unknown"}
	}
	return s.jobs.Start(jobs.Spec{Kind: "compose", Title: "Update " + name, HostID: hostID, StackID: r.ID, Actor: actor,
		Plan: []string{"Writing compose file", "Applying changes"}},
		func(ctx context.Context, j *jobs.Job) error {
			conn, err := s.conns.Get(ctx, hostID)
			if err != nil {
				return err
			}
			j.Step("Writing compose file", r.ComposePath())
			if err := WriteFile(ctx, conn, r.ComposePath(), []byte(content)); err != nil {
				return err
			}
			s.remember(hostID, name, content)
			j.Step("Applying changes", "docker compose up -d")
			if err := dockerops.RunLogged(ctx, conn, j, ComposeCmd(r, "up -d --remove-orphans")); err != nil {
				return err
			}
			if managed {
				s.touchDeploy(context.Background(), r.ID)
			}
			j.Set("stack", name)
			s.mon.Refresh(context.Background(), hostID)
			return nil
		})
}

// Actions are the supported stack actions.
var Actions = map[string]string{"up": "up -d --remove-orphans", "down": "down", "stop": "stop", "restart": "restart", "pull": "pull"}

// Action runs a stack action (job).
func (s *Service) Action(ctx context.Context, hostID, name, action, actor string) (string, error) {
	if _, ok := Actions[action]; !ok && action != "redeploy" {
		return "", &dockerops.BadRequest{Msg: fmt.Sprintf("unknown stack action %q", action)}
	}
	r, managed, err := s.locate(ctx, hostID, name)
	if err != nil {
		return "", err
	}
	title := strings.ToUpper(action[:1]) + action[1:] + " " + name
	plan := []string{"Running docker compose " + action}
	if action == "redeploy" {
		plan = []string{"Pulling images", "Recreating services"}
		if r.Source == "git" {
			plan = nil // the git redeploy adds its own steps
		}
	}
	return s.jobs.Start(jobs.Spec{Kind: "stack", Title: title, HostID: hostID, StackID: r.ID, Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error {
			return s.runAction(ctx, j, r, managed, action)
		})
}

func (s *Service) runAction(ctx context.Context, j *jobs.Job, r Row, managed bool, action string) error {
	conn, err := s.conns.Get(ctx, r.HostID)
	if err != nil {
		return err
	}
	j.Set("stack", r.Name)
	if action != "redeploy" {
		j.Step("Running docker compose "+action, "")
		if err := dockerops.RunLogged(ctx, conn, j, ComposeCmd(r, Actions[action])); err != nil {
			return err
		}
		if action == "up" && managed {
			s.touchDeploy(context.Background(), r.ID)
		}
		s.mon.Refresh(context.Background(), r.HostID)
		return nil
	}
	if r.Source == "git" {
		if s.GitRedeploy == nil {
			return errors.New("git redeploy is not available")
		}
		return s.GitRedeploy(ctx, j, r)
	}
	j.Step("Pulling images", "")
	if err := dockerops.RunLogged(ctx, conn, j, ComposeCmd(r, "pull")); err != nil {
		return err
	}
	j.Step("Recreating services", "")
	if err := dockerops.RunLogged(ctx, conn, j, ComposeCmd(r, "up -d --remove-orphans")); err != nil {
		return err
	}
	if managed {
		s.touchDeploy(context.Background(), r.ID)
	}
	s.mon.Refresh(context.Background(), r.HostID)
	return nil
}

// SetAutoDeploy toggles auto-deploy on a managed stack.
func (s *Service) SetAutoDeploy(ctx context.Context, hostID, name string, v bool) (model.Stack, error) {
	tag, err := s.db.Exec(ctx, `UPDATE stacks SET auto_deploy = $3 WHERE host_id::text = $1 AND name = $2`, hostID, name, v)
	if err != nil {
		return model.Stack{}, err
	}
	if tag.RowsAffected() == 0 {
		return model.Stack{}, &dockerops.BadRequest{Msg: "only managed stacks can auto-deploy"}
	}
	list, err := s.List(ctx, hostID)
	if err != nil {
		return model.Stack{}, err
	}
	for _, st := range list {
		if st.Name == name {
			return st, nil
		}
	}
	return model.Stack{}, ErrNotFound
}

// ResolveName finds a stack name case-insensitively for MCP callers.
func (s *Service) Exists(ctx context.Context, hostID, name string) bool {
	_, _, err := s.locate(ctx, hostID, name)
	return err == nil
}
