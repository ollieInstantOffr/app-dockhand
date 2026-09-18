package system

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"

	"dockhand/internal/dockerops"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
)

type gitResult struct {
	latest, current, url, err string
	available                 bool
	date                      *time.Time
	notes                     []string
	source                    model.SystemSource
	at                        time.Time
}

// gitInfo returns the git-mode update state. ok is false when Dockhand isn't
// running from a git checkout (then release-based checks apply).
func (s *Service) gitInfo(ctx context.Context, force bool) (gitResult, bool) {
	if !CanSelfUpdate() {
		return gitResult{}, false
	}
	s.mu.Lock()
	fresh := !force && s.gitLocal != nil && time.Since(s.gitAt) < 10*time.Minute
	s.mu.Unlock()
	if !fresh {
		s.refreshGit(ctx)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gitLocal == nil || s.gitDep == nil {
		return gitResult{}, false
	}
	l, r := *s.gitLocal, s.gitRemote
	if s.bootSHA != "" {
		l.SHA = s.bootSHA
	}
	repo := l.FullName()
	if repo == "" {
		repo = s.settings.Get().Updates.Repo
	}
	res := gitResult{
		current: short(l.SHA),
		at:      s.gitAt,
		err:     s.gitErr,
		notes:   []string{},
		source:  model.SystemSource{Repo: repo, Branch: l.Branch, SHA: short(l.SHA), Path: s.gitDep.Dir},
	}
	if r != nil {
		res.latest = short(r.SHA)
		res.available = r.SHA != l.SHA && r.Ahead > 0
		res.date = r.Date
		res.url = r.CompareURL
		if res.available {
			res.notes = r.Messages
		}
	}
	return res, true
}

// refreshGit re-reads the checkout and asks GitHub for the branch head.
func (s *Service) refreshGit(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cli, err := dockerLocal()
	if err != nil {
		return
	}
	defer cli.Close()
	dep, err := selfDeployment(cctx, cli)
	if err != nil {
		slog.Debug("git update check", "err", err)
		return
	}
	local, err := readCheckout(cctx, cli, dep.Dir)
	if err != nil {
		slog.Info("git update check: not a git checkout", "dir", dep.Dir, "err", err)
		return
	}
	owner, repo := local.Owner, local.Repo
	if owner == "" {
		owner, repo = splitRepo(s.settings.Get().Updates.Repo)
	}
	branch := local.Branch
	if branch == "" || branch == "HEAD" {
		branch = "main"
	}
	var remote *remoteHead
	var checkErr string
	if owner != "" {
		s.mu.Lock()
		if s.bootSHA == "" {
			s.bootSHA = local.SHA
		}
		base := s.bootSHA
		s.mu.Unlock()
		remote, err = fetchRemoteHead(cctx, owner, repo, branch, base, os.Getenv("GITHUB_TOKEN"))
		if err != nil {
			checkErr = "Couldn't reach GitHub: " + err.Error()
			slog.Warn("git update check", "repo", owner+"/"+repo, "err", err)
		}
	} else {
		checkErr = "The checkout's origin isn't a GitHub repository"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gitDep, s.gitLocal, s.gitAt, s.gitErr = dep, local, time.Now(), checkErr
	if remote != nil || s.gitRemote == nil {
		s.gitRemote = remote
	}
}

// startGit pulls the checkout and rebuilds the stack from a detached helper.
func (s *Service) startGit(ctx context.Context, actor string) (string, error) {
	s.mu.Lock()
	dep, local, remote, running := s.gitDep, s.gitLocal, s.gitRemote, s.bootSHA
	s.mu.Unlock()
	if running == "" && local != nil {
		running = local.SHA
	}
	if dep == nil || local == nil {
		return "", &dockerops.BadRequest{Msg: "couldn't find Dockhand's git checkout"}
	}
	target := local.SHA
	if remote != nil {
		target = remote.SHA
	}
	up := s.settings.Get().Updates
	title := "Update Dockhand to " + short(target)
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
			cli, err := dockerLocal()
			if err != nil {
				return err
			}
			defer cli.Close()
			if _, err := cli.ImageInspect(ctx, helperImage); err != nil {
				rd, err := cli.ImagePull(ctx, helperImage, image.PullOptions{})
				if err != nil {
					return fmt.Errorf("pull %s: %w", helperImage, err)
				}
				_, _ = io.Copy(io.Discard, rd)
				rd.Close()
			}
			j.Log("info", "helper image "+helperImage+" ready")

			dir := shellQuote(dep.Dir)
			files := ""
			for _, f := range dep.ConfigFiles {
				files += " -f " + shellQuote(f)
			}
			compose := "docker compose -p " + shellQuote(dep.Project) + " --project-directory " + dir + files
			script := strings.Join([]string{
				"set -e",
				"sleep 3",
				"apk add --no-cache git >/dev/null",
				"git config --global --add safe.directory '*'",
				"cd " + dir,
				"git pull --ff-only",
				compose + " up -d --build --remove-orphans",
			}, " && ")
			j.Step("Handing off to updater", "git pull --ff-only && docker compose up -d --build")
			j.Log("cmd", "$ cd "+dep.Dir+" && git pull --ff-only")
			j.Log("cmd", "$ "+compose+" up -d --build --remove-orphans")
			var hid string
			err = s.db.QueryRow(ctx, `INSERT INTO update_history (version, from_version, status, note) VALUES ($1, $2, 'pending', $3) RETURNING id::text`,
				target, running, "git pull + rebuild handed off to updater").Scan(&hid)
			if err != nil {
				return err
			}
			binds := []string{"/var/run/docker.sock:/var/run/docker.sock", dep.Dir + ":" + dep.Dir}
			// Clear finished updaters from earlier runs; this one is kept so its logs can be read.
			if old, err := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "dockhand.helper=self-update"), filters.Arg("status", "exited"))}); err == nil {
				for _, c := range old {
					_ = cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{})
				}
			}
			created, err := cli.ContainerCreate(ctx,
				&container.Config{Image: helperImage, Cmd: []string{"sh", "-c", script}, WorkingDir: dep.Dir,
					Labels: map[string]string{"dockhand.helper": "self-update"}},
				&container.HostConfig{AutoRemove: false, Binds: binds}, nil, nil, fmt.Sprintf("dockhand-updater-%d", time.Now().Unix()))
			if err == nil {
				err = cli.ContainerStart(ctx, created.ID, container.StartOptions{})
			}
			if err != nil {
				_, _ = s.db.Exec(context.Background(), `UPDATE update_history SET status='failed', note=$2 WHERE id::text=$1`, hid, err.Error())
				return fmt.Errorf("start updater: %w", err)
			}
			j.Logf("ok", "updater %s started — Dockhand rebuilds and restarts in a minute or two", created.ID[:12])
			j.Logf("muted", "follow it with: docker logs -f %s", created.ID[:12])
			j.Set("handedOff", true)
			j.Set("version", short(target))
			return nil
		})
}

// reconcileGitUpdate marks a pending git update done once the new API reads its checkout.
func (s *Service) reconcileGitUpdate(id, target string) {
	time.Sleep(5 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s.refreshGit(ctx)
	s.mu.Lock()
	local := s.gitLocal
	s.mu.Unlock()
	if local == nil {
		return
	}
	if local.SHA == target {
		_, _ = s.db.Exec(ctx, `UPDATE update_history SET status = 'success', note = 'Updated from git' WHERE id::text = $1`, id)
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE update_history SET status = 'failed', note = $2 WHERE id::text = $1`, id,
		fmt.Sprintf("Restarted on %s instead of %s — check the updater container's logs", short(local.SHA), short(target)))
}
