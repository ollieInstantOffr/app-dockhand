package gitdeploy

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"dockhand/internal/dockerops"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/stacks"
	"dockhand/internal/util"
)

// Pull & rebuild for git-backed stacks, the equivalent of
//
//	git pull && docker compose up -d --build
//
// for two kinds of stack:
//   - managed: deployed by Dockhand from GitHub. The branch head is fetched
//     through the GitHub API, so the host needs neither git nor a token.
//   - checkout: a git clone living on the host (you cloned it and ran compose
//     yourself). Dockhand runs git there, with the host's own credentials.

const statusScript = `set -u
cd %s || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4
echo "@@top"; git rev-parse --show-toplevel
echo "@@branch"; git rev-parse --abbrev-ref HEAD
echo "@@head"; git rev-parse HEAD
echo "@@remote"; git remote get-url origin 2>/dev/null
echo "@@fetch"; git fetch --quiet --prune origin 2>&1 | tail -3
echo "@@upstream"; git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
echo "@@latest"; git rev-parse @{u} 2>/dev/null
echo "@@counts"; git rev-list --left-right --count HEAD...@{u} 2>/dev/null
echo "@@log"; git log --format='%%H%%x09%%an%%x09%%cI%%x09%%s' HEAD..@{u} -n 20 2>/dev/null
echo "@@dirty"; git status --porcelain --untracked-files=no 2>/dev/null | wc -l
echo "@@end"
`

// GitStatus reports how far a stack is behind its branch.
func (s *Service) GitStatus(ctx context.Context, hostID, name string) (model.StackGitStatus, error) {
	r, managed, err := s.stacks.Locate(ctx, hostID, name)
	if err != nil {
		return model.StackGitStatus{}, err
	}
	out := model.StackGitStatus{Kind: "none", Path: r.Path, Commits: []model.GitCommit{}}
	if managed && r.Source == "git" {
		return s.managedStatus(ctx, r)
	}
	if r.Path == "" {
		return out, nil
	}
	conn, err := s.conns.Get(ctx, hostID)
	if err != nil {
		return out, err
	}
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	res, err := conn.HostExec(cctx, fmt.Sprintf(statusScript, util.Shq(r.Path)))
	if err != nil && strings.TrimSpace(res.Stdout) == "" {
		switch res.Code {
		case 3, 4:
			return out, nil // not a directory, or not a git checkout: nothing to pull
		case 127:
			out.Error = "git isn't installed on this host"
			return out, nil
		}
		if strings.Contains(res.Stderr+res.Stdout, "not found") {
			out.Error = "git isn't installed on this host"
			return out, nil
		}
		return out, nil
	}
	sec := sectionsOf(res.Stdout)
	out.Kind = "checkout"
	out.Path = first(sec["top"])
	out.Branch = first(sec["branch"])
	out.Current = first(sec["head"])
	out.Latest = first(sec["latest"])
	out.Repo = remoteName(first(sec["remote"]))
	if f := strings.Join(sec["fetch"], " "); f != "" && (strings.Contains(f, "fatal") || strings.Contains(f, "denied") || strings.Contains(f, "Could not")) {
		out.Error = "git fetch failed on the host: " + f
	}
	if first(sec["upstream"]) == "" {
		out.Error = fmt.Sprintf("branch %s has no upstream to pull from", out.Branch)
	}
	if c := strings.Fields(first(sec["counts"])); len(c) == 2 {
		out.Ahead, _ = strconv.Atoi(c[0])
		out.Behind, _ = strconv.Atoi(c[1])
	}
	for _, l := range sec["log"] {
		f := strings.SplitN(l, "\t", 4)
		if len(f) < 4 {
			continue
		}
		c := model.GitCommit{SHA: f[0], Author: f[1], Message: f[3]}
		if t, err := time.Parse(time.RFC3339, f[2]); err == nil {
			c.Date = &t
		}
		out.Commits = append(out.Commits, c)
	}
	out.Dirty, _ = strconv.Atoi(strings.TrimSpace(first(sec["dirty"])))
	if strings.HasPrefix(out.Repo, "github.com/") {
		out.CompareURL = "https://" + out.Repo + "/compare/" + out.Current + "..." + out.Latest
	}
	return out, nil
}

func (s *Service) managedStatus(ctx context.Context, r stacks.Row) (model.StackGitStatus, error) {
	out := model.StackGitStatus{Kind: "managed", Repo: r.Repo, Branch: r.Branch, Path: r.Path, Current: r.SHA, Commits: []model.GitCommit{}}
	owner, repo, ok := strings.Cut(r.Repo, "/")
	if !ok {
		out.Error = "this stack has no repository"
		return out, nil
	}
	acctID := ""
	if r.AccountID != nil {
		acctID = *r.AccountID
	}
	a, err := s.accountForRepo(ctx, owner, repo, acctID)
	if err != nil {
		out.Error = err.Error()
		return out, nil
	}
	cl, err := s.Client(ctx, a)
	if err != nil {
		out.Error = err.Error()
		return out, nil
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	latest, err := cl.ResolveRef(cctx, owner, repo, r.Branch)
	if err != nil {
		out.Error = err.Error()
		return out, nil
	}
	out.Latest = latest
	if r.SHA == "" || r.SHA == latest {
		return out, nil
	}
	cmp, err := cl.Compare(cctx, owner, repo, r.SHA, latest)
	if err != nil {
		out.Behind = -1 // unknown: the deployed commit may have been rewritten away
		return out, nil
	}
	out.Behind, out.Ahead, out.CompareURL = cmp.AheadBy, cmp.BehindBy, cmp.HTMLURL
	for _, c := range cmp.Commits {
		out.Commits = append(out.Commits, model.GitCommit{SHA: c.SHA, Message: c.Message, Author: c.Author, Date: c.Date})
	}
	return out, nil
}

// PullAndRebuild fetches the stack's branch head and runs docker compose up -d --build (job).
func (s *Service) PullAndRebuild(ctx context.Context, hostID, name string, in model.StackGitUpdate, actor string) (string, error) {
	r, managed, err := s.stacks.Locate(ctx, hostID, name)
	if err != nil {
		return "", err
	}
	rec, err := s.hosts.Get(ctx, hostID)
	if err != nil {
		return "", err
	}
	if managed && r.Source == "git" {
		owner, repo, ok := strings.Cut(r.Repo, "/")
		if !ok {
			return "", &dockerops.BadRequest{Msg: "this stack has no repository"}
		}
		acctID := ""
		if r.AccountID != nil {
			acctID = *r.AccountID
		}
		a, err := s.accountForRepo(ctx, owner, repo, acctID)
		if err != nil {
			return "", err
		}
		p := deployParams{account: a, owner: owner, repo: repo, branch: r.Branch, composeFile: r.ComposeFile,
			hostID: r.HostID, path: r.Path, name: r.Name, env: r.Env, autoDeploy: r.AutoDeploy, actor: actor,
			pullImages: in.PullImages, noCache: in.NoCache}
		return s.jobs.Start(jobs.Spec{Kind: "git", Title: fmt.Sprintf("Pull & rebuild %s on %s", r.Name, rec.Name), HostID: rec.ID,
			StackID: r.ID, Actor: actor, Plan: deployPlan},
			func(ctx context.Context, j *jobs.Job) error { return s.runDeploy(ctx, j, p) })
	}

	st, err := s.GitStatus(ctx, hostID, name)
	if err != nil {
		return "", err
	}
	if st.Kind != "checkout" {
		return "", &dockerops.BadRequest{Msg: "this stack wasn't deployed from git, and its folder isn't a git checkout"}
	}
	if st.Error != "" && !strings.HasPrefix(st.Error, "git fetch failed") {
		return "", &dockerops.BadRequest{Msg: st.Error}
	}
	if st.Dirty > 0 && !in.Force {
		return "", &dockerops.BadRequest{Msg: fmt.Sprintf("%d tracked file(s) were changed on the host — choose \"Discard local changes\" to overwrite them, or commit them first", st.Dirty)}
	}
	plan := []string{"Fetching", "Updating checkout", "Building", "Starting"}
	return s.jobs.Start(jobs.Spec{Kind: "git", Title: fmt.Sprintf("Pull & rebuild %s on %s", r.Name, rec.Name), HostID: rec.ID,
		StackID: r.ID, Actor: actor, Plan: plan},
		func(ctx context.Context, j *jobs.Job) error { return s.runCheckoutUpdate(ctx, j, r, st, in) })
}

func (s *Service) runCheckoutUpdate(ctx context.Context, j *jobs.Job, r stacks.Row, st model.StackGitStatus, in model.StackGitUpdate) error {
	conn, err := s.conns.Get(ctx, r.HostID)
	if err != nil {
		return err
	}
	j.Set("stack", r.Name)
	git := "git -C " + util.Shq(st.Path)
	run := func(cmd string) error {
		j.Log("cmd", "$ "+cmd)
		code, err := conn.HostExecStream(ctx, cmd+" 2>&1", func(_, line string) {
			if strings.TrimSpace(line) != "" {
				j.Log("info", line)
			}
		})
		if err != nil {
			return err
		}
		if code != 0 {
			return fmt.Errorf("%s exited with status %d", strings.Fields(cmd)[0], code)
		}
		return nil
	}

	j.Step("Fetching", st.Repo+"@"+st.Branch)
	if err := run(git + " fetch --prune origin"); err != nil {
		return fmt.Errorf("git fetch: %w (the host's own git credentials are used)", err)
	}

	before := st.Current
	if in.Force {
		j.Step("Updating checkout", "git reset --hard @{u}")
		if err := run(git + " reset --hard @{u}"); err != nil {
			return err
		}
	} else {
		j.Step("Updating checkout", "git merge --ff-only @{u}")
		if err := run(git + " merge --ff-only @{u}"); err != nil {
			return errors.New("the branch can't fast-forward (local commits on the host?) — choose \"Discard local changes\" to reset it to the remote")
		}
	}
	if res, err := conn.HostExec(ctx, git+" rev-parse HEAD"); err == nil {
		after := strings.TrimSpace(res.Stdout)
		j.Set("sha", after)
		if after == before {
			j.Log("muted", "already at the latest commit — rebuilding anyway")
		} else {
			j.Logf("ok", "%s → %s", shortSHA(before), shortSHA(after))
		}
	}

	if err := s.buildAndUp(ctx, j, r, in); err != nil {
		return err
	}
	s.mon.Refresh(context.Background(), r.HostID)
	return nil
}

// buildAndUp runs the optional explicit build (for --pull / --no-cache) and then compose up.
func (s *Service) buildAndUp(ctx context.Context, j *jobs.Job, r stacks.Row, in model.StackGitUpdate) error {
	c, err := s.conns.Get(ctx, r.HostID)
	if err != nil {
		return err
	}
	flags := []string{}
	if in.PullImages {
		flags = append(flags, "--pull")
	}
	if in.NoCache {
		flags = append(flags, "--no-cache")
	}
	j.Step("Building", "docker compose build "+strings.Join(flags, " "))
	if len(flags) > 0 {
		if err := dockerops.RunLogged(ctx, c, j, stacks.ComposeCmd(r, "build "+strings.Join(flags, " "))); err != nil {
			return err
		}
	} else {
		j.Log("muted", "building as part of compose up")
	}
	j.Step("Starting", "docker compose up -d --build")
	up := "up -d --build --remove-orphans"
	if in.PullImages {
		up += " --pull always"
	}
	return dockerops.RunLogged(ctx, c, j, stacks.ComposeCmd(r, up))
}

// ─── small helpers ──────────────────────────────────────────────────────────

func sectionsOf(out string) map[string][]string {
	res := map[string][]string{}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		l := strings.TrimRight(line, "\r")
		if strings.HasPrefix(l, "@@") {
			cur = strings.TrimSpace(l[2:])
			continue
		}
		if cur != "" && strings.TrimSpace(l) != "" {
			res[cur] = append(res[cur], l)
		}
	}
	return res
}

func first(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}

// remoteName turns "git@github.com:org/app.git" or "https://github.com/org/app" into "github.com/org/app".
func remoteName(u string) string {
	u = strings.TrimSpace(u)
	u = strings.TrimSuffix(u, ".git")
	if strings.HasPrefix(u, "git@") {
		u = strings.Replace(strings.TrimPrefix(u, "git@"), ":", "/", 1)
	}
	for _, p := range []string{"https://", "http://", "ssh://git@", "ssh://"} {
		u = strings.TrimPrefix(u, p)
	}
	if i := strings.Index(u, "@"); i >= 0 && strings.Index(u, "/") > i {
		u = u[i+1:] // drop credentials embedded in the URL
	}
	return u
}
