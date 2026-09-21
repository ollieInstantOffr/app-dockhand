package gitdeploy

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"dockhand/internal/db"
	"dockhand/internal/dockerops"
	"dockhand/internal/github"
	"dockhand/internal/hosts"
	"dockhand/internal/jobs"
	"dockhand/internal/model"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
	"dockhand/internal/stacks"
	"dockhand/internal/util"
)

// ─── Repos ──────────────────────────────────────────────────────────────────

// RepoQuery filters the repo list.
type RepoQuery struct {
	Q           string
	ComposeOnly bool
	AccountID   string
	All         bool // ignore repoAccess=selected (account-repos picker)
}

// Repos lists synced repos.
func (s *Service) Repos(ctx context.Context, q RepoQuery) ([]model.Repo, error) {
	sql := `SELECT r.id, r.account_id::text, r.owner, r.name, r.private, r.description, r.default_branch, r.compose_files, r.pushed_at,
		coalesce((SELECT h.name FROM stacks st JOIN hosts h ON h.id = st.host_id
			WHERE st.source = 'git' AND lower(st.repo_full_name) = lower(r.owner || '/' || r.name) ORDER BY st.last_deploy_at DESC NULLS LAST LIMIT 1), ''),
		a.repo_access, a.selected_repos
		FROM git_repos r JOIN git_accounts a ON a.id = r.account_id WHERE a.enabled`
	args := []any{}
	if q.AccountID != "" {
		args = append(args, q.AccountID)
		sql += fmt.Sprintf(` AND a.id::text = $%d`, len(args))
	}
	if q.ComposeOnly {
		sql += ` AND jsonb_array_length(r.compose_files) > 0`
	}
	if q.Q != "" {
		args = append(args, "%"+strings.ToLower(q.Q)+"%")
		sql += fmt.Sprintf(` AND (lower(r.owner || '/' || r.name) LIKE $%d OR lower(r.description) LIKE $%d)`, len(args), len(args))
	}
	sql += ` ORDER BY r.pushed_at DESC NULLS LAST, r.name LIMIT 1000`
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Repo{}
	for rows.Next() {
		var r model.Repo
		var cf, sel []byte
		var access string
		if err := rows.Scan(&r.ID, &r.AccountID, &r.Owner, &r.Name, &r.Private, &r.Description, &r.DefaultBranch, &cf, &r.PushedAt,
			&r.DeployedOn, &access, &sel); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(cf, &r.ComposeFiles)
		r.ComposeFiles = util.NZ(r.ComposeFiles)
		r.FullName = r.Owner + "/" + r.Name
		if access == "selected" && !q.All {
			var selected []string
			_ = json.Unmarshal(sel, &selected)
			if !containsFold(selected, r.FullName) {
				continue
			}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func containsFold(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

// accountForRepo picks the account to use for a repository.
func (s *Service) accountForRepo(ctx context.Context, owner, name, accountID string) (Account, error) {
	if accountID != "" {
		return s.Account(ctx, accountID)
	}
	var id string
	err := s.db.QueryRow(ctx, `SELECT r.account_id::text FROM git_repos r JOIN git_accounts a ON a.id = r.account_id
		WHERE lower(r.owner) = lower($1) AND lower(r.name) = lower($2) AND a.enabled ORDER BY a.created_at LIMIT 1`, owner, name).Scan(&id)
	if db.IsNoRows(err) {
		return Account{}, fmt.Errorf("%w: no connected account can access %s/%s", ErrAccountNotFound, owner, name)
	}
	if err != nil {
		return Account{}, err
	}
	return s.Account(ctx, id)
}

// Branches lists a repo's branches.
func (s *Service) Branches(ctx context.Context, owner, name, accountID string) ([]model.Branch, error) {
	a, err := s.accountForRepo(ctx, owner, name, accountID)
	if err != nil {
		return nil, err
	}
	cl, err := s.Client(ctx, a)
	if err != nil {
		return nil, err
	}
	bs, err := cl.Branches(ctx, owner, name)
	if err != nil {
		return nil, err
	}
	var def string
	_ = s.db.QueryRow(ctx, `SELECT default_branch FROM git_repos WHERE lower(owner) = lower($1) AND lower(name) = lower($2) LIMIT 1`, owner, name).Scan(&def)
	out := []model.Branch{}
	for _, b := range bs {
		out = append(out, model.Branch{Name: b.Name, SHA: b.SHA, UpdatedAt: b.UpdatedAt, IsDefault: b.Name == def})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].IsDefault && !out[j].IsDefault })
	return out, nil
}

// Inspect reads compose files, services and .env.example from a repo at ref.
func (s *Service) Inspect(ctx context.Context, owner, name, ref, file, accountID string) (model.RepoInspect, error) {
	res := model.RepoInspect{ComposeFiles: []string{}, Services: []model.InspectService{}, Env: []model.InspectEnv{}}
	a, err := s.accountForRepo(ctx, owner, name, accountID)
	if err != nil {
		return res, err
	}
	cl, err := s.Client(ctx, a)
	if err != nil {
		return res, err
	}
	if ref == "" {
		_ = s.db.QueryRow(ctx, `SELECT default_branch FROM git_repos WHERE lower(owner) = lower($1) AND lower(name) = lower($2) LIMIT 1`, owner, name).Scan(&ref)
		if ref == "" {
			ref = "main"
		}
	}
	files, err := cl.FindComposeFiles(ctx, owner, name, ref)
	if err != nil {
		return res, err
	}
	res.ComposeFiles = util.NZ(files)
	if file == "" && len(files) > 0 {
		file = files[0]
	}
	if file == "" {
		return res, nil
	}
	content, err := cl.FileContent(ctx, owner, name, file, ref)
	if err != nil {
		return res, err
	}
	for _, svc := range github.ParseComposeServices(content) {
		res.Services = append(res.Services, model.InspectService{Name: svc.Name, Image: svc.Image, Meta: svc.Meta})
	}
	for _, c := range envExampleCandidates(file) {
		b, err := cl.FileContent(ctx, owner, name, c, ref)
		if err != nil || b == nil {
			continue
		}
		for _, e := range github.ParseEnvExample(b) {
			res.Env = append(res.Env, model.InspectEnv{K: e.Key, V: e.Value, Required: e.Required, Comment: e.Comment})
		}
		break
	}
	return res, nil
}

// envExampleCandidates lists where a compose file's .env.example may live, in order.
func envExampleCandidates(composeFile string) []string {
	dir := path.Dir(composeFile)
	c := []string{path.Join(dir, ".env.example"), path.Join(dir, ".env.sample"), path.Join(dir, "example.env")}
	if dir != "." {
		c = append(c, ".env.example")
	}
	for i := range c {
		c[i] = strings.TrimPrefix(c[i], "./")
	}
	return c
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

var nonName = regexp.MustCompile(`[^a-z0-9_-]+`)

// StackName derives a compose project name from a directory or repo name.
func StackName(s string) string {
	n := nonName.ReplaceAllString(strings.ToLower(path.Base(strings.TrimRight(s, "/"))), "-")
	n = strings.Trim(n, "-_")
	if n == "" {
		n = "app"
	}
	if len(n) > 63 {
		n = n[:63]
	}
	return n
}

type deployParams struct {
	account     Account
	owner, repo string
	branch      string
	composeFile string // repo-relative
	hostID      string
	path        string
	name        string
	env         []model.KV
	autoDeploy  bool
	actor       string
	pullImages  bool // pull newer base images while building
	noCache     bool // rebuild every layer
}

// prepare validates a deploy request and resolves its defaults (shared by Deploy and DryRun).
func (s *Service) prepare(ctx context.Context, in model.GitDeployInput, actor string) (deployParams, hosts.Record, error) {
	in.Owner, in.Name, in.Branch = strings.TrimSpace(in.Owner), strings.TrimSpace(in.Name), strings.TrimSpace(in.Branch)
	if in.Owner == "" || in.Name == "" {
		return deployParams{}, hosts.Record{}, &dockerops.BadRequest{Msg: "owner and name are required"}
	}
	rec, err := s.hosts.Get(ctx, in.HostID)
	if err != nil {
		return deployParams{}, rec, err
	}
	a, err := s.accountForRepo(ctx, in.Owner, in.Name, in.AccountID)
	if err != nil {
		return deployParams{}, rec, err
	}
	if in.Branch == "" {
		_ = s.db.QueryRow(ctx, `SELECT default_branch FROM git_repos WHERE lower(owner)=lower($1) AND lower(name)=lower($2) LIMIT 1`, in.Owner, in.Name).Scan(&in.Branch)
		if in.Branch == "" {
			in.Branch = "main"
		}
	}
	p := strings.TrimSpace(in.Path)
	if p == "" {
		p = s.cfg.StacksDir + "/" + StackName(in.Name)
	}
	if !path.IsAbs(p) || strings.Contains(p, "..") || p == "/" {
		return deployParams{}, rec, &dockerops.BadRequest{Msg: "path must be an absolute directory (e.g. " + s.cfg.StacksDir + "/app)"}
	}
	p = path.Clean(p)
	cf := strings.TrimPrefix(strings.TrimSpace(in.ComposeFile), "/")
	if cf == "" {
		cf = "docker-compose.yml"
	}
	if strings.Contains(cf, "..") {
		return deployParams{}, rec, &dockerops.BadRequest{Msg: "invalid compose file path"}
	}
	for _, kv := range in.Env {
		if strings.ContainsAny(kv.K, "= \n") {
			return deployParams{}, rec, &dockerops.BadRequest{Msg: fmt.Sprintf("invalid variable name %q", kv.K)}
		}
	}
	return deployParams{account: a, owner: in.Owner, repo: in.Name, branch: in.Branch, composeFile: cf, hostID: rec.ID, path: p,
		name: StackName(p), env: util.NZ(in.Env), autoDeploy: in.AutoDeploy, actor: actor}, rec, nil
}

// Deploy validates the input and starts a git deploy job.
func (s *Service) Deploy(ctx context.Context, in model.GitDeployInput, actor string) (string, error) {
	dp, rec, err := s.prepare(ctx, in, actor)
	if err != nil {
		return "", err
	}
	in.Owner, in.Name = dp.owner, dp.repo
	stackID := ""
	if r, err := s.stacks.Row(ctx, rec.ID, dp.name); err == nil {
		if r.Source != "git" || !strings.EqualFold(r.Repo, in.Owner+"/"+in.Name) {
			return "", &dockerops.BadRequest{Msg: fmt.Sprintf("a different stack named %q already exists on %s", dp.name, rec.Name)}
		}
		stackID = r.ID
	}
	return s.jobs.Start(jobs.Spec{Kind: "git", Title: fmt.Sprintf("Deploy %s/%s to %s", in.Owner, in.Name, rec.Name), HostID: rec.ID,
		StackID: stackID, Actor: actor, Plan: deployPlan},
		func(ctx context.Context, j *jobs.Job) error { return s.runDeploy(ctx, j, dp) })
}

var deployPlan = []string{"Fetching repository", "Uploading to host", "Writing .env", "Building & starting", "Saving stack"}

func (s *Service) runDeploy(ctx context.Context, j *jobs.Job, p deployParams) error {
	j.Set("stack", p.name)
	j.Set("repo", p.owner+"/"+p.repo)
	cl, err := s.Client(ctx, p.account)
	if err != nil {
		return err
	}
	conn, err := s.conns.Get(ctx, p.hostID)
	if err != nil {
		return err
	}
	j.Step("Fetching repository", fmt.Sprintf("%s/%s@%s", p.owner, p.repo, p.branch))
	body, sha, err := cl.Tarball(ctx, p.owner, p.repo, p.branch)
	if err != nil {
		return err
	}
	defer body.Close()
	j.Logf("info", "commit %s", shortSHA(sha))
	j.Set("sha", sha)

	j.Step("Uploading to host", p.path)
	counter := &countingReader{r: body}
	// -v lists what the archive contains, so files deleted from the repo can be removed below.
	cmd := "mkdir -p " + util.Shq(p.path) + " && tar xzvf - --strip-components=1 -C " + util.Shq(p.path)
	j.Log("cmd", "$ "+cmd)
	res, err := conn.Exec(ctx, cmd, counter)
	if err != nil {
		if res.Stderr != "" {
			j.Log("error", strings.TrimSpace(res.Stderr))
		}
		return fmt.Errorf("extract on host: %w", err)
	}
	j.Done(fmt.Sprintf("%s → %s", util.HumanBytes(counter.n), p.path))
	s.pruneDeleted(ctx, j, conn, p.path, archiveFiles(res.Stdout+"\n"+res.Stderr))

	composePath := path.Join(p.path, p.composeFile)
	envDir := path.Dir(composePath)
	if len(p.env) > 0 {
		j.Step("Writing .env", path.Join(envDir, ".env"))
		if err := stacks.WriteFile(ctx, conn, path.Join(envDir, ".env"), []byte(envFile(p.env))); err != nil {
			return err
		}
		j.Logf("info", "wrote %d variables", len(p.env))
	} else {
		j.Skip("Writing .env", "no variables")
	}

	row := stacks.Row{HostID: p.hostID, Name: p.name, Path: p.path, ComposeFile: p.composeFile, Source: "git",
		AccountID: &p.account.ID, Repo: p.owner + "/" + p.repo, Branch: p.branch, SHA: sha, AutoDeploy: p.autoDeploy, Env: p.env}
	j.Step("Building & starting", "docker compose up -d --build")
	if p.pullImages || p.noCache {
		flags := []string{}
		if p.pullImages {
			flags = append(flags, "--pull")
		}
		if p.noCache {
			flags = append(flags, "--no-cache")
		}
		if err := dockerops.RunLogged(ctx, conn, j, stacks.ComposeCmd(row, "build "+strings.Join(flags, " "))); err != nil {
			return err
		}
	}
	up := "up -d --build --remove-orphans"
	if p.pullImages {
		up += " --pull always"
	}
	if err := dockerops.RunLogged(ctx, conn, j, stacks.ComposeCmd(row, up)); err != nil {
		return err
	}

	j.Step("Saving stack", p.name)
	now := time.Now()
	row.LastDeployAt = &now
	id, err := s.stacks.Upsert(context.Background(), row)
	if err != nil {
		return err
	}
	j.SetStack(id)
	if p.autoDeploy && p.account.Webhook {
		if err := s.ensureWebhook(ctx, cl, p.owner, p.repo); err != nil {
			j.Log("warn", "could not create the push webhook: "+err.Error())
		} else {
			j.Log("muted", "push webhook is set up for auto-deploy")
		}
	}
	j.Logf("ok", "%s deployed at %s", p.name, shortSHA(sha))
	s.mon.Refresh(context.Background(), p.hostID)
	return nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// envFile renders variables as a .env file.
func envFile(env []model.KV) string {
	var b strings.Builder
	for _, kv := range env {
		if kv.K == "" {
			continue
		}
		b.WriteString(kv.K + "=" + quoteEnv(kv.V) + "\n")
	}
	return b.String()
}

// quoteEnv quotes a .env value when needed.
func quoteEnv(v string) string {
	if v == "" || !strings.ContainsAny(v, " \t#\"'$\\\n") {
		return v
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "$", "$$").Replace(v) + `"`
}

// redeploy re-fetches a git stack at its branch head (stack "redeploy" action and webhooks).
func (s *Service) redeploy(ctx context.Context, j *jobs.Job, r stacks.Row) error {
	owner, repo, ok := strings.Cut(r.Repo, "/")
	if !ok {
		return errors.New("stack has no repository")
	}
	acctID := ""
	if r.AccountID != nil {
		acctID = *r.AccountID
	}
	a, err := s.accountForRepo(ctx, owner, repo, acctID)
	if err != nil {
		return err
	}
	return s.runDeploy(ctx, j, deployParams{account: a, owner: owner, repo: repo, branch: r.Branch, composeFile: r.ComposeFile,
		hostID: r.HostID, path: r.Path, name: r.Name, env: r.Env, autoDeploy: r.AutoDeploy, actor: j.Actor()})
}

func (s *Service) webhookURL() string {
	return strings.TrimRight(s.settings.Get().General.PublicURL, "/") + "/api/webhooks/github"
}

func (s *Service) ensureWebhook(ctx context.Context, cl *github.Client, owner, repo string) error {
	sec, err := s.WebhookSecret()
	if err != nil {
		return err
	}
	u := s.webhookURL()
	if strings.Contains(u, "localhost") || strings.Contains(u, "127.0.0.1") {
		return fmt.Errorf("the public URL (%s) isn't reachable from GitHub — set it under Settings → General", u)
	}
	return cl.CreateWebhook(ctx, owner, repo, u, sec)
}

// ─── Webhook secret ─────────────────────────────────────────────────────────

// EnsureWebhookSecret generates the webhook secret on first boot.
func (s *Service) EnsureWebhookSecret(ctx context.Context) error {
	if s.settings.Get().GitHub.SecretEnc != "" {
		if _, err := s.WebhookSecret(); err == nil {
			return nil
		}
	}
	_, err := s.RotateSecret(ctx)
	return err
}

// WebhookSecret returns the decrypted webhook secret.
func (s *Service) WebhookSecret() (string, error) {
	return s.box.Decrypt(s.settings.Get().GitHub.SecretEnc)
}

// RotateSecret generates and stores a new webhook secret.
func (s *Service) RotateSecret(ctx context.Context) (string, error) {
	sec := hex.EncodeToString(secret.RandomBytes(24))
	enc, err := s.box.Encrypt(sec)
	if err != nil {
		return "", err
	}
	err = s.settings.Update(ctx, "github", func(st *settings.Settings) { st.GitHub.SecretEnc = enc })
	return sec, err
}

// ─── Webhook ────────────────────────────────────────────────────────────────

type pushEvent struct {
	Ref        string `json:"ref"`
	After      string `json:"after"`
	Deleted    bool   `json:"deleted"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	HeadCommit *struct {
		Message string `json:"message"`
	} `json:"head_commit"`
}

// WebhookResult summarises what a webhook delivery triggered.
type WebhookResult struct {
	Jobs    []string `json:"jobs"`
	Skipped []string `json:"skipped"`
}

// HandleWebhook verifies and processes a GitHub delivery.
func (s *Service) HandleWebhook(ctx context.Context, event, signature string, body []byte) (WebhookResult, error) {
	res := WebhookResult{Jobs: []string{}, Skipped: []string{}}
	sec, err := s.WebhookSecret()
	if err != nil || sec == "" {
		return res, errors.New("webhook secret is not configured")
	}
	if !github.VerifySignature([]byte(sec), body, signature) {
		return res, ErrBadSignature
	}
	if event != "push" {
		return res, nil
	}
	var ev pushEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return res, &dockerops.BadRequest{Msg: "invalid push payload"}
	}
	if ev.Deleted || !strings.HasPrefix(ev.Ref, "refs/heads/") {
		return res, nil
	}
	branch := strings.TrimPrefix(ev.Ref, "refs/heads/")
	st := s.settings.Get()
	if !st.GitHub.AutoDeploy {
		res.Skipped = append(res.Skipped, "auto-deploy is disabled globally")
		return res, nil
	}
	rows, err := s.stacks.RowsByRepo(ctx, ev.Repository.FullName)
	if err != nil {
		return res, err
	}
	for _, r := range rows {
		if !r.AutoDeploy || r.Branch != branch {
			continue
		}
		if r.SHA == ev.After && ev.After != "" {
			res.Skipped = append(res.Skipped, r.Name+": already at "+shortSHA(ev.After))
			continue
		}
		if st.GitHub.WaitChecks && ev.After != "" {
			if skip := s.checksFailed(ctx, r, ev.After); skip != "" {
				res.Skipped = append(res.Skipped, r.Name+": "+skip)
				continue
			}
		}
		r := r
		title := fmt.Sprintf("Auto-deploy %s (%s)", r.Name, shortSHA(ev.After))
		id, err := s.jobs.Start(jobs.Spec{Kind: "git", Title: title, HostID: r.HostID, StackID: r.ID, Actor: "auto-deploy", Plan: deployPlan},
			func(ctx context.Context, j *jobs.Job) error {
				if ev.HeadCommit != nil {
					j.Log("muted", "push: "+util.Truncate(strings.SplitN(ev.HeadCommit.Message, "\n", 2)[0], 120))
				}
				return s.redeploy(ctx, j, r)
			})
		if err != nil {
			slog.Warn("webhook deploy", "stack", r.Name, "err", err)
			continue
		}
		res.Jobs = append(res.Jobs, id)
	}
	return res, nil
}

func (s *Service) checksFailed(ctx context.Context, r stacks.Row, sha string) string {
	owner, repo, _ := strings.Cut(r.Repo, "/")
	acctID := ""
	if r.AccountID != nil {
		acctID = *r.AccountID
	}
	a, err := s.accountForRepo(ctx, owner, repo, acctID)
	if err != nil {
		return ""
	}
	cl, err := s.Client(ctx, a)
	if err != nil {
		return ""
	}
	st, err := cl.CombinedStatus(ctx, owner, repo, sha)
	if err == nil && st == "failure" {
		return "checks failed for " + shortSHA(sha)
	}
	return ""
}

// ErrBadSignature is returned for webhook deliveries with an invalid signature.
var ErrBadSignature = errors.New("invalid webhook signature")

// manifestFile records which files the last deploy extracted, so the next one
// can remove files that were deleted from the repository — what git pull would
// do — without touching anything the app itself created in the stack folder.
const manifestFile = ".dockhand-files"

// archiveFiles turns tar -v output ("owner-repo-sha/path/to/file") into repo-relative file paths.
// GitHub archives have a single top-level folder; if the listing doesn't look like
// that (a tar that prints already-stripped names), it returns nil so nothing is pruned.
func archiveFiles(out string) []string {
	var files []string
	top := ""
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "x "))
		if l == "" {
			continue
		}
		head, rel, _ := strings.Cut(l, "/")
		if top == "" {
			top = head
		} else if head != top {
			return nil // not one top-level folder: don't guess
		}
		if strings.HasSuffix(l, "/") || rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "..") {
			continue
		}
		files = append(files, rel)
	}
	return files
}

func (s *Service) pruneDeleted(ctx context.Context, j *jobs.Job, conn *hosts.Conn, dir string, now []string) {
	if len(now) == 0 {
		return // couldn't read the archive listing; leave everything in place
	}
	manifest := path.Join(dir, manifestFile)
	prev, _ := conn.Exec(ctx, "cat "+util.Shq(manifest)+" 2>/dev/null || true", nil)
	keep := map[string]bool{}
	for _, f := range now {
		keep[f] = true
	}
	var gone []string
	for _, f := range strings.Split(prev.Stdout, "\n") {
		f = strings.TrimSpace(f)
		if f == "" || keep[f] || f == ".env" || f == manifestFile || strings.HasPrefix(f, "/") || strings.Contains(f, "..") {
			continue
		}
		gone = append(gone, f)
	}
	if len(gone) > 0 && len(gone) <= 2000 {
		for i := 0; i < len(gone); i += 200 {
			end := i + 200
			if end > len(gone) {
				end = len(gone)
			}
			quoted := make([]string, 0, end-i)
			for _, f := range gone[i:end] {
				quoted = append(quoted, util.Shq(f))
			}
			if _, err := conn.Exec(ctx, "cd "+util.Shq(dir)+" && rm -f -- "+strings.Join(quoted, " "), nil); err != nil {
				j.Logf("warn", "couldn't remove files deleted from the repository: %v", err)
				break
			}
		}
		shown := gone
		if len(shown) > 10 {
			shown = shown[:10]
		}
		j.Logf("info", "removed %d file(s) deleted from the repository: %s%s", len(gone), strings.Join(shown, ", "), map[bool]string{true: "…", false: ""}[len(gone) > 10])
	}
	if err := stacks.WriteFile(ctx, conn, manifest, []byte(strings.Join(now, "\n")+"\n")); err != nil {
		j.Logf("warn", "couldn't record the file list: %v", err)
	}
}
