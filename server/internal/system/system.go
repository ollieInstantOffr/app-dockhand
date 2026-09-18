// Package system reports Dockhand's version, checks for new releases and
// performs best-effort self-updates through a detached helper container.
package system

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"

	"dockhand/internal/config"
	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/github"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/settings"
	"dockhand/internal/util"
)

const helperImage = "docker:cli"

type Service struct {
	cfg      *config.Config
	db       *db.DB
	settings *settings.Store
	jobs     *jobs.Runner

	mu      sync.Mutex
	cache   *release
	cacheAt time.Time
	cacheCh string
	cacheRp string
}

type release struct {
	tag, url  string
	notes     []string
	published *time.Time
}

func New(cfg *config.Config, pool *db.DB, st *settings.Store, jr *jobs.Runner) *Service {
	return &Service{cfg: cfg, db: pool, settings: st, jobs: jr}
}

// RecordBoot reconciles update history with the running version.
func (s *Service) RecordBoot(ctx context.Context) {
	var id, version, status string
	err := s.db.QueryRow(ctx, `SELECT id::text, version, status FROM update_history ORDER BY at DESC LIMIT 1`).Scan(&id, &version, &status)
	cur := s.cfg.Version
	switch {
	case db.IsNoRows(err):
		_, _ = s.db.Exec(ctx, `INSERT INTO update_history (version, status, note) VALUES ($1, 'success', 'Installed')`, cur)
	case err != nil:
		slog.Warn("update history", "err", err)
	case status == "pending":
		if strings.TrimPrefix(version, "v") == strings.TrimPrefix(cur, "v") || version == "latest" {
			_, _ = s.db.Exec(ctx, `UPDATE update_history SET status = 'success', version = $2, note = 'Update completed' WHERE id::text = $1`, id, cur)
		} else {
			_, _ = s.db.Exec(ctx, `UPDATE update_history SET status = 'failed', note = $2 WHERE id::text = $1`, id,
				fmt.Sprintf("Dockhand restarted but is still running %s", cur))
		}
	case strings.TrimPrefix(version, "v") != strings.TrimPrefix(cur, "v"):
		_, _ = s.db.Exec(ctx, `INSERT INTO update_history (version, from_version, status, note) VALUES ($1, $2, 'success', 'Detected new version at startup')`, cur, version)
	}
}

// CanSelfUpdate reports whether the local Docker socket is usable.
func CanSelfUpdate() bool { return config.HasLocalDocker() }

// Info builds SystemInfo, refreshing the release cache when force is set or it's older than an hour.
func (s *Service) Info(ctx context.Context, force bool) (model.SystemInfo, error) {
	up := s.settings.Get().Updates
	info := model.SystemInfo{Version: s.cfg.Version, Notes: []string{}, CanSelfUpdate: CanSelfUpdate(),
		Source:  model.SystemSource{Repo: up.Repo, Branch: channelBranch(up.Channel), SHA: os.Getenv("DOCKHAND_COMMIT"), Path: up.ComposeFile},
		History: []model.UpdateHistory{}}
	rel, at := s.latest(ctx, up.Repo, up.Channel, force)
	if rel != nil {
		info.Latest = strings.TrimPrefix(rel.tag, "v")
		info.UpdateAvailable = CompareVersions(info.Latest, s.cfg.Version) > 0
		info.ReleasedAt = rel.published
		info.Notes = rel.notes
		info.ChangelogURL = rel.url
	}
	if !at.IsZero() {
		info.CheckedAt = &at
	}
	rows, err := s.db.Query(ctx, `SELECT id::text, version, from_version, status, note, at FROM update_history ORDER BY at DESC LIMIT 20`)
	if err != nil {
		return info, err
	}
	defer rows.Close()
	for rows.Next() {
		var h model.UpdateHistory
		if err := rows.Scan(&h.ID, &h.Version, &h.FromVersion, &h.Status, &h.Note, &h.At); err != nil {
			return info, err
		}
		info.History = append(info.History, h)
	}
	return info, rows.Err()
}

func channelBranch(ch string) string {
	if env := os.Getenv("DOCKHAND_BRANCH"); env != "" {
		return env
	}
	return "main"
}

func (s *Service) latest(ctx context.Context, repo, channel string, force bool) (*release, time.Time) {
	s.mu.Lock()
	if !force && s.cacheCh == channel && s.cacheRp == repo && time.Since(s.cacheAt) < time.Hour {
		r, at := s.cache, s.cacheAt
		s.mu.Unlock()
		return r, at
	}
	s.mu.Unlock()
	owner, name, ok := strings.Cut(repo, "/")
	var rel *release
	if ok {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		r, err := github.New("https://api.github.com", os.Getenv("GITHUB_TOKEN")).LatestRelease(cctx, owner, name, channel != "stable")
		cancel()
		if err != nil {
			slog.Debug("release check failed", "repo", repo, "err", err)
		} else if r != nil {
			rel = &release{tag: r.Tag, url: r.URL, notes: ReleaseNotes(r.Body), published: util.TimePtr(r.PublishedAt)}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Keep the last good result if this check failed.
	if rel != nil || s.cacheRp != repo || s.cacheCh != channel {
		s.cache = rel
	}
	s.cacheAt, s.cacheCh, s.cacheRp = time.Now(), channel, repo
	return s.cache, s.cacheAt
}

// ReleaseNotes extracts bullet lines from a release body.
func ReleaseNotes(body string) []string {
	out := []string{}
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		for _, p := range []string{"- ", "* ", "+ "} {
			if strings.HasPrefix(l, p) {
				t := strings.TrimSpace(strings.TrimPrefix(l, p))
				if t != "" {
					out = append(out, t)
				}
				break
			}
		}
		if len(out) >= 30 {
			break
		}
	}
	return out
}

// CompareVersions compares dotted versions (leading "v" ignored; pre-release suffixes sort lower).
func CompareVersions(a, b string) int {
	pa, sa := splitVersion(a)
	pb, sb := splitVersion(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case sa == sb:
		return 0
	case sa == "":
		return 1
	case sb == "":
		return -1
	case sa < sb:
		return -1
	}
	return 1
}

func splitVersion(v string) ([3]int, string) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	suffix := ""
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		suffix = v[i+1:]
		v = v[:i]
	}
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(p)
	}
	return out, suffix
}

// Update starts a self-update job to the latest release.
func (s *Service) Update(ctx context.Context, actor string) (string, error) {
	info, _ := s.Info(ctx, false)
	tag := "latest"
	if info.Latest != "" {
		tag = info.Latest
	}
	return s.start(ctx, actor, tag, "Update Dockhand to "+tag)
}

// Rollback starts a job that switches back to the previous version.
func (s *Service) Rollback(ctx context.Context, actor string) (string, error) {
	var prev string
	err := s.db.QueryRow(ctx, `SELECT from_version FROM update_history WHERE status = 'success' AND from_version <> ''
		AND version = $1 ORDER BY at DESC LIMIT 1`, s.cfg.Version).Scan(&prev)
	if err != nil || prev == "" {
		return "", &dockerops.BadRequest{Msg: "no previous version to roll back to"}
	}
	return s.start(ctx, actor, prev, "Roll back Dockhand to "+prev)
}

func (s *Service) start(ctx context.Context, actor, tag, title string) (string, error) {
	if !CanSelfUpdate() {
		return "", &dockerops.BadRequest{Msg: "self-update needs the Docker socket mounted at " + config.LocalDockerSocket}
	}
	up := s.settings.Get().Updates
	if !path.IsAbs(up.ComposeFile) {
		return "", &dockerops.BadRequest{Msg: "updates.composeFile must be an absolute path on the Docker host"}
	}
	from := s.cfg.Version
	return s.jobs.Start(jobs.Spec{Kind: "self-update", Title: title, Actor: actor,
		Plan: []string{"Backing up database", "Preparing updater", "Handing off to updater"}},
		func(ctx context.Context, j *jobs.Job) error {
			if up.Backup {
				if err := s.backup(ctx, j); err != nil {
					return err
				}
			} else {
				j.Skip("Backing up database", "disabled in settings")
			}
			j.Step("Preparing updater", helperImage)
			cli, err := client.NewClientWithOpts(client.WithHost("unix://"+config.LocalDockerSocket), client.WithAPIVersionNegotiation())
			if err != nil {
				return err
			}
			defer cli.Close()
			rd, err := cli.ImagePull(ctx, helperImage, image.PullOptions{})
			if err != nil {
				return fmt.Errorf("pull %s: %w", helperImage, err)
			}
			_, _ = io.Copy(io.Discard, rd)
			rd.Close()
			j.Log("info", "pulled "+helperImage)

			dir := path.Dir(up.ComposeFile)
			f := util.Shq(up.ComposeFile)
			script := "sleep 3 && docker compose -f " + f + " pull && docker compose -f " + f + " up -d"
			if up.Build == "build" {
				script = "sleep 3 && docker compose -f " + f + " build --pull && docker compose -f " + f + " up -d"
			}
			j.Step("Handing off to updater", script)
			j.Log("cmd", "$ "+script)
			var hid string
			err = s.db.QueryRow(ctx, `INSERT INTO update_history (version, from_version, status, note) VALUES ($1, $2, 'pending', $3) RETURNING id::text`,
				tag, from, "Handed off to updater container").Scan(&hid)
			if err != nil {
				return err
			}
			created, err := cli.ContainerCreate(ctx, &container.Config{Image: helperImage, Cmd: []string{"sh", "-c", script}, WorkingDir: dir,
				Env: []string{"DOCKHAND_TAG=" + tag}, Labels: map[string]string{"dockhand.helper": "self-update"}},
				&container.HostConfig{AutoRemove: true, Binds: []string{config.LocalDockerSocket + ":/var/run/docker.sock", dir + ":" + dir}},
				nil, nil, fmt.Sprintf("dockhand-updater-%d", time.Now().Unix()))
			if err == nil {
				err = cli.ContainerStart(ctx, created.ID, container.StartOptions{})
			}
			if err != nil {
				_, _ = s.db.Exec(context.Background(), `UPDATE update_history SET status='failed', note=$2 WHERE id::text=$1`, hid, err.Error())
				return fmt.Errorf("start updater: %w", err)
			}
			j.Logf("ok", "updater %s started — Dockhand will restart in a moment", created.ID[:12])
			j.Set("handedOff", true)
			j.Set("version", tag)
			return nil
		})
}

func (s *Service) backup(ctx context.Context, j *jobs.Job) error {
	pgdump, err := exec.LookPath("pg_dump")
	if err != nil {
		j.Skip("Backing up database", "pg_dump is not available")
		j.Log("warn", "pg_dump not found — skipping the database backup")
		return nil
	}
	file := path.Join(s.cfg.BackupsDir, "dockhand-db-"+time.Now().UTC().Format("20060102-150405")+".dump")
	j.Step("Backing up database", file)
	if err := os.MkdirAll(s.cfg.BackupsDir, 0o750); err != nil {
		j.Log("warn", "cannot create backups dir: "+err.Error())
		j.Done("skipped: backups dir not writable")
		return nil
	}
	bctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(bctx, pgdump, "--format=custom", "--file="+file, "--dbname="+s.cfg.DatabaseURL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("pg_dump failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	if st, err := os.Stat(file); err == nil {
		j.Done(fmt.Sprintf("%s (%s)", file, util.HumanBytes(st.Size())))
	}
	return nil
}
