package system

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"dockhand/internal/config"
)

// Git-based updates: Dockhand is normally deployed from a git checkout with
// `docker compose up -d --build`. The API finds that checkout from its own
// compose labels, reads the checked-out commit with a throwaway git container,
// and compares it with the head of the same branch on GitHub. An update is
// `git pull --ff-only` + `docker compose up -d --build` in a helper container.

const gitImage = "alpine/git:latest"

// deployment describes the compose project the running API belongs to.
type deployment struct {
	Project     string   // compose project name
	Dir         string   // working dir on the Docker host (the git checkout)
	ConfigFiles []string // compose files, absolute host paths
}

// checkout is the state of the git checkout the stack was built from.
type checkout struct {
	SHA    string // full commit sha of HEAD
	Branch string // current branch, e.g. "main"
	Owner  string // GitHub owner from the origin remote
	Repo   string // GitHub repository name
}

func (c checkout) FullName() string {
	if c.Owner == "" {
		return ""
	}
	return c.Owner + "/" + c.Repo
}

// remoteHead is the newest commit on the tracked branch plus what changed since HEAD.
type remoteHead struct {
	SHA        string
	Date       *time.Time
	Messages   []string // first lines of the commits between HEAD and the remote head
	Ahead      int      // commits the remote has that HEAD doesn't
	CompareURL string
}

func dockerLocal() (*client.Client, error) {
	return client.NewClientWithOpts(client.WithHost("unix://"+config.LocalDockerSocket), client.WithAPIVersionNegotiation())
}

// selfDeployment inspects the API's own container for compose labels.
func selfDeployment(ctx context.Context, cli *client.Client) (*deployment, error) {
	id, _ := os.Hostname()
	info, err := cli.ContainerInspect(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("inspect own container: %w", err)
	}
	l := info.Config.Labels
	d := &deployment{Project: l["com.docker.compose.project"], Dir: l["com.docker.compose.project.working_dir"]}
	for _, f := range strings.Split(l["com.docker.compose.project.config_files"], ",") {
		if f = strings.TrimSpace(f); f != "" {
			d.ConfigFiles = append(d.ConfigFiles, f)
		}
	}
	if d.Project == "" || d.Dir == "" {
		return nil, errors.New("Dockhand isn't running from a docker compose project")
	}
	return d, nil
}

// runHelper runs a short-lived container and returns its combined output.
func runHelper(ctx context.Context, cli *client.Client, img string, script string, binds []string, workdir string) (string, int, error) {
	if _, err := cli.ImageInspect(ctx, img); err != nil {
		rd, err := cli.ImagePull(ctx, img, image.PullOptions{})
		if err != nil {
			return "", -1, fmt.Errorf("pull %s: %w", img, err)
		}
		_, _ = io.Copy(io.Discard, rd)
		rd.Close()
	}
	created, err := cli.ContainerCreate(ctx,
		&container.Config{Image: img, Entrypoint: []string{"sh", "-c"}, Cmd: []string{script}, WorkingDir: workdir,
			Labels: map[string]string{"dockhand.helper": "git"}},
		&container.HostConfig{Binds: binds}, nil, nil, "")
	if err != nil {
		return "", -1, err
	}
	defer func() {
		_ = cli.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})
	}()
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", -1, err
	}
	waitC, errC := cli.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
	code := -1
	select {
	case w := <-waitC:
		code = int(w.StatusCode)
	case err := <-errC:
		return "", -1, err
	case <-ctx.Done():
		return "", -1, ctx.Err()
	}
	logs, err := cli.ContainerLogs(ctx, created.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return "", code, err
	}
	defer logs.Close()
	var out bytes.Buffer
	_, _ = stdcopy.StdCopy(&out, &out, logs)
	return out.String(), code, nil
}

// readCheckout reads HEAD, the branch and the origin remote of dir.
func readCheckout(ctx context.Context, cli *client.Client, dir string) (*checkout, error) {
	q := shellQuote(dir)
	script := "git config --global --add safe.directory '*' && " +
		"git -C " + q + " rev-parse HEAD && git -C " + q + " rev-parse --abbrev-ref HEAD && git -C " + q + " remote get-url origin"
	out, code, err := runHelper(ctx, cli, gitImage, script, []string{dir + ":" + dir + ":ro"}, "")
	if err != nil {
		return nil, err
	}
	lines := nonEmptyLines(out)
	if code != 0 || len(lines) < 3 {
		return nil, fmt.Errorf("%s is not a git checkout: %s", dir, strings.TrimSpace(out))
	}
	c := &checkout{SHA: lines[0], Branch: lines[1]}
	c.Owner, c.Repo = parseGitHubRemote(lines[2])
	return c, nil
}

var shaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	// git may print warnings first; keep the tail that we asked for.
	for len(out) > 3 && !shaRe.MatchString(out[0]) {
		out = out[1:]
	}
	return out
}

// parseGitHubRemote extracts owner/repo from https, ssh or scp-style GitHub remotes.
func parseGitHubRemote(remote string) (string, string) {
	r := strings.TrimSpace(remote)
	r = strings.TrimSuffix(r, "/")
	r = strings.TrimSuffix(r, ".git")
	if strings.HasPrefix(r, "git@") {
		if _, after, ok := strings.Cut(r, ":"); ok {
			r = "https://github.com/" + after
		}
	}
	u, err := url.Parse(r)
	if err != nil || !strings.EqualFold(strings.TrimPrefix(u.Hostname(), "www."), "github.com") {
		return "", ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

func splitRepo(full string) (string, string) {
	full = strings.TrimSpace(full)
	full = strings.TrimPrefix(full, "https://github.com/")
	full = strings.TrimSuffix(strings.TrimSuffix(full, "/"), ".git")
	o, r, ok := strings.Cut(full, "/")
	if !ok || o == "" || r == "" {
		return "", ""
	}
	return o, r
}

// fetchRemoteHead asks GitHub for the head of branch and the commits since base.
func fetchRemoteHead(ctx context.Context, owner, repo, branch, base, token string) (*remoteHead, error) {
	var head struct {
		SHA    string `json:"sha"`
		Commit struct {
			Committer struct {
				Date time.Time `json:"date"`
			} `json:"committer"`
		} `json:"commit"`
	}
	if err := ghGet(ctx, fmt.Sprintf("https://api.github.com/repos/%s/%s/commits/%s", owner, repo, url.PathEscape(branch)), token, &head); err != nil {
		return nil, err
	}
	rh := &remoteHead{SHA: head.SHA}
	if !head.Commit.Committer.Date.IsZero() {
		d := head.Commit.Committer.Date
		rh.Date = &d
	}
	if base == "" || base == head.SHA {
		return rh, nil
	}
	var cmp struct {
		HTMLURL string `json:"html_url"`
		AheadBy int    `json:"ahead_by"`
		Status  string `json:"status"`
		Commits []struct {
			Commit struct {
				Message string `json:"message"`
			} `json:"commit"`
		} `json:"commits"`
	}
	if err := ghGet(ctx, fmt.Sprintf("https://api.github.com/repos/%s/%s/compare/%s...%s", owner, repo, base, head.SHA), token, &cmp); err != nil {
		// The running commit isn't on GitHub (unpushed local work) — nothing to update to.
		rh.Ahead = 0
		rh.CompareURL = fmt.Sprintf("https://github.com/%s/%s/commits/%s", owner, repo, url.PathEscape(branch))
		return rh, nil
	}
	rh.Ahead = cmp.AheadBy
	rh.CompareURL = cmp.HTMLURL
	for i := len(cmp.Commits) - 1; i >= 0 && len(rh.Messages) < 30; i-- { // newest first
		msg, _, _ := strings.Cut(cmp.Commits[i].Commit.Message, "\n")
		if msg = strings.TrimSpace(msg); msg != "" {
			rh.Messages = append(rh.Messages, msg)
		}
	}
	return rh, nil
}

func ghGet(ctx context.Context, u, token string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("GitHub %s: %s", res.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(res.Body).Decode(v)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
