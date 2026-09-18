package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"
)

type apiRepo struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	FullName    string     `json:"full_name"`
	Description *string    `json:"description"`
	Private     bool       `json:"private"`
	Default     string     `json:"default_branch"`
	PushedAt    *time.Time `json:"pushed_at"`
	Owner       struct {
		Login string `json:"login"`
	} `json:"owner"`
}

func (r apiRepo) toRepo() Repo {
	out := Repo{
		ID:            r.ID,
		Owner:         r.Owner.Login,
		Name:          r.Name,
		FullName:      r.FullName,
		DefaultBranch: r.Default,
		Private:       r.Private,
	}
	if r.Description != nil {
		out.Description = *r.Description
	}
	if r.PushedAt != nil {
		out.PushedAt = *r.PushedAt
	}
	if out.FullName == "" && out.Owner != "" {
		out.FullName = out.Owner + "/" + out.Name
	}
	return out
}

// Viewer returns the login of the authenticated account and whether it is a
// "user" or an "org".
func (c *Client) Viewer(ctx context.Context) (string, string, error) {
	var u struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, "/user", nil, &u); err != nil {
		return "", "", err
	}
	kind := "user"
	if strings.EqualFold(u.Type, "Organization") {
		kind = "org"
	}
	return u.Login, kind, nil
}

// ListRepos lists repositories. owner == "" lists everything the token can
// access; otherwise the org's or user's repos.
func (c *Client) ListRepos(ctx context.Context, owner string, isOrg bool) ([]Repo, error) {
	var p string
	switch {
	case owner == "":
		p = "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100"
	case isOrg:
		p = "/orgs/" + esc(owner) + "/repos?type=all&sort=pushed&per_page=100"
	default:
		p = "/users/" + esc(owner) + "/repos?type=owner&sort=pushed&per_page=100"
	}
	var out []Repo
	err := c.getPaged(ctx, p, func(raw json.RawMessage) error {
		var page []apiRepo
		if err := json.Unmarshal(raw, &page); err != nil {
			return fmt.Errorf("GitHub: decode repos: %w", err)
		}
		for _, r := range page {
			out = append(out, r.toRepo())
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list repos: %w", err)
	}
	return out, nil
}

// InstallationRepos lists the repositories a GitHub App installation token
// can access.
func (c *Client) InstallationRepos(ctx context.Context) ([]Repo, error) {
	var out []Repo
	err := c.getPaged(ctx, "/installation/repositories?per_page=100", func(raw json.RawMessage) error {
		var page struct {
			Repositories []apiRepo `json:"repositories"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return fmt.Errorf("GitHub: decode installation repos: %w", err)
		}
		for _, r := range page.Repositories {
			out = append(out, r.toRepo())
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list installation repos: %w", err)
	}
	return out, nil
}

// composeMaxDepth is the maximum number of directories above a compose file.
const composeMaxDepth = 3

// IsComposeFile reports whether a repository path looks like a Compose file
// Dockhand should offer: compose.y(a)ml, docker-compose.y(a)ml,
// *.compose.y(a)ml or docker-compose.*.y(a)ml, at most composeMaxDepth
// directories deep and not inside node_modules / vendor / hidden dirs.
func IsComposeFile(p string) bool {
	p = strings.Trim(p, "/")
	if p == "" {
		return false
	}
	dirs := strings.Split(p, "/")
	base := strings.ToLower(dirs[len(dirs)-1])
	dirs = dirs[:len(dirs)-1]
	if len(dirs) > composeMaxDepth {
		return false
	}
	for _, d := range dirs {
		if d == "node_modules" || d == "vendor" || strings.HasPrefix(d, ".") {
			return false
		}
	}
	return composeRank(base) >= 0
}

// composeRank returns 0 for canonical names, 1 for variants, -1 for no match.
func composeRank(base string) int {
	var stem string
	switch {
	case strings.HasSuffix(base, ".yaml"):
		stem = strings.TrimSuffix(base, ".yaml")
	case strings.HasSuffix(base, ".yml"):
		stem = strings.TrimSuffix(base, ".yml")
	default:
		return -1
	}
	switch {
	case stem == "compose" || stem == "docker-compose":
		return 0
	case strings.HasSuffix(stem, ".compose") && len(stem) > len(".compose"):
		return 1
	case strings.HasPrefix(stem, "docker-compose.") && len(stem) > len("docker-compose."):
		return 1
	}
	return -1
}

// SortComposeFiles orders paths root-first (by depth), then canonical names
// before variants, then alphabetically.
func SortComposeFiles(paths []string) {
	sort.SliceStable(paths, func(i, j int) bool {
		di, dj := strings.Count(paths[i], "/"), strings.Count(paths[j], "/")
		if di != dj {
			return di < dj
		}
		ri, rj := composeRank(strings.ToLower(path.Base(paths[i]))), composeRank(strings.ToLower(path.Base(paths[j])))
		if ri != rj {
			return ri < rj
		}
		return paths[i] < paths[j]
	})
}

// FilterComposeFiles returns the matching paths, sorted.
func FilterComposeFiles(paths []string) []string {
	out := []string{}
	for _, p := range paths {
		if IsComposeFile(p) {
			out = append(out, strings.Trim(p, "/"))
		}
	}
	SortComposeFiles(out)
	return out
}

// FindComposeFiles returns the Compose files in the repository at ref using
// the recursive git trees API.
func (c *Client) FindComposeFiles(ctx context.Context, owner, repo, ref string) ([]string, error) {
	var tree struct {
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	p := repoPath(owner, repo) + "/git/trees/" + escPath(ref) + "?recursive=1"
	if _, err := c.doJSON(ctx, http.MethodGet, p, nil, &tree); err != nil {
		if IsNotFound(err) {
			// Empty repositories have no tree.
			return []string{}, nil
		}
		return nil, fmt.Errorf("find compose files in %s/%s@%s: %w", owner, repo, ref, err)
	}
	paths := make([]string, 0, len(tree.Tree))
	for _, e := range tree.Tree {
		if e.Type == "blob" {
			paths = append(paths, e.Path)
		}
	}
	return FilterComposeFiles(paths), nil
}

// Branches lists all branches. UpdatedAt is always nil.
func (c *Client) Branches(ctx context.Context, owner, repo string) ([]Branch, error) {
	var out []Branch
	err := c.getPaged(ctx, repoPath(owner, repo)+"/branches?per_page=100", func(raw json.RawMessage) error {
		var page []struct {
			Name   string `json:"name"`
			Commit struct {
				SHA string `json:"sha"`
			} `json:"commit"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return fmt.Errorf("GitHub: decode branches: %w", err)
		}
		for _, b := range page {
			out = append(out, Branch{Name: b.Name, SHA: b.Commit.SHA})
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list branches of %s/%s: %w", owner, repo, err)
	}
	return out, nil
}

const maxFileSize = 10 << 20

// FileContent returns the raw content of a file at ref ("" = default branch).
// It returns (nil, nil) when the file does not exist.
func (c *Client) FileContent(ctx context.Context, owner, repo, filePath, ref string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	p := repoPath(owner, repo) + "/contents/" + escPath(filePath)
	if ref != "" {
		p += "?ref=" + url.QueryEscape(ref)
	}
	req, err := c.newRequest(ctx, http.MethodGet, p, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github.raw+json")
	resp, err := c.send(req)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s from %s/%s: %w", filePath, owner, repo, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxFileSize+1))
	if err != nil {
		return nil, fmt.Errorf("read %s from %s/%s: %w", filePath, owner, repo, err)
	}
	if len(b) > maxFileSize {
		return nil, fmt.Errorf("read %s from %s/%s: file larger than %d bytes", filePath, owner, repo, maxFileSize)
	}
	return b, nil
}

// ResolveRef returns the commit SHA for a branch, tag or SHA.
func (c *Client) ResolveRef(ctx context.Context, owner, repo, ref string) (string, error) {
	var commit struct {
		SHA string `json:"sha"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+escPath(ref), nil, &commit); err != nil {
		return "", fmt.Errorf("resolve %s in %s/%s: %w", ref, owner, repo, err)
	}
	if commit.SHA == "" {
		return "", fmt.Errorf("resolve %s in %s/%s: empty commit sha", ref, owner, repo)
	}
	return commit.SHA, nil
}

// Tarball resolves ref to a commit and streams the gzipped tarball of that
// commit. The caller must close the reader. Only ctx bounds the download.
func (c *Client) Tarball(ctx context.Context, owner, repo, ref string) (io.ReadCloser, string, error) {
	sha, err := c.ResolveRef(ctx, owner, repo, ref)
	if err != nil {
		return nil, "", err
	}
	req, err := c.newRequest(ctx, http.MethodGet, repoPath(owner, repo)+"/tarball/"+esc(sha), nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.send(req)
	if err != nil {
		return nil, "", fmt.Errorf("download %s/%s@%s: %w", owner, repo, sha, err)
	}
	return resp.Body, sha, nil
}

// CombinedStatus returns "success", "failure" or "pending" for ref, combining
// the legacy commit statuses and check runs. Any failure wins; otherwise any
// pending status or incomplete check run yields "pending". A commit with no
// statuses and no check runs is reported as "success".
func (c *Client) CombinedStatus(ctx context.Context, owner, repo, ref string) (string, error) {
	var st struct {
		State      string `json:"state"`
		TotalCount int    `json:"total_count"`
		Statuses   []struct {
			State string `json:"state"`
		} `json:"statuses"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+escPath(ref)+"/status", nil, &st); err != nil {
		return "", fmt.Errorf("commit status of %s/%s@%s: %w", owner, repo, ref, err)
	}
	failed, pending := false, false
	if st.TotalCount > 0 || len(st.Statuses) > 0 {
		switch st.State {
		case "failure", "error":
			failed = true
		case "pending":
			pending = true
		}
	}

	var checks struct {
		TotalCount int `json:"total_count"`
		CheckRuns  []struct {
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
		} `json:"check_runs"`
	}
	if _, err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/commits/"+escPath(ref)+"/check-runs?per_page=100", nil, &checks); err != nil {
		// Tokens without checks permission get 403/404; fall back to statuses.
		var ae *APIError
		if !(errors.As(err, &ae) && (ae.Status == http.StatusForbidden || ae.Status == http.StatusNotFound)) {
			return "", fmt.Errorf("check runs of %s/%s@%s: %w", owner, repo, ref, err)
		}
	}
	for _, cr := range checks.CheckRuns {
		if cr.Status != "completed" {
			pending = true
			continue
		}
		switch cr.Conclusion {
		case "failure", "timed_out", "action_required", "startup_failure":
			failed = true
		}
	}
	switch {
	case failed:
		return "failure", nil
	case pending:
		return "pending", nil
	default:
		return "success", nil
	}
}

// CreateWebhook installs a push webhook delivering JSON to url. It is a no-op
// if a hook with the same URL already exists.
func (c *Client) CreateWebhook(ctx context.Context, owner, repo, hookURL, secret string) error {
	exists := false
	err := c.getPaged(ctx, repoPath(owner, repo)+"/hooks?per_page=100", func(raw json.RawMessage) error {
		var page []struct {
			Config struct {
				URL string `json:"url"`
			} `json:"config"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return fmt.Errorf("GitHub: decode hooks: %w", err)
		}
		for _, h := range page {
			if h.Config.URL == hookURL {
				exists = true
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("list webhooks of %s/%s: %w", owner, repo, err)
	}
	if exists {
		return nil
	}
	body := map[string]any{
		"name":   "web",
		"active": true,
		"events": []string{"push"},
		"config": map[string]any{
			"url":          hookURL,
			"content_type": "json",
			"secret":       secret,
			"insecure_ssl": "0",
		},
	}
	if _, err := c.doJSON(ctx, http.MethodPost, repoPath(owner, repo)+"/hooks", body, nil); err != nil {
		return fmt.Errorf("create webhook on %s/%s: %w", owner, repo, err)
	}
	return nil
}

type apiRelease struct {
	TagName     string     `json:"tag_name"`
	Name        string     `json:"name"`
	Body        string     `json:"body"`
	HTMLURL     string     `json:"html_url"`
	Prerelease  bool       `json:"prerelease"`
	Draft       bool       `json:"draft"`
	PublishedAt *time.Time `json:"published_at"`
}

func (r apiRelease) toRelease() *Release {
	out := &Release{Tag: r.TagName, Name: r.Name, Body: r.Body, URL: r.HTMLURL, Prerelease: r.Prerelease}
	if r.PublishedAt != nil {
		out.PublishedAt = *r.PublishedAt
	}
	return out
}

// LatestRelease returns the latest release. With prerelease=true the newest
// non-draft release including prereleases is returned. It returns (nil, nil)
// when the repository has no matching release.
func (c *Client) LatestRelease(ctx context.Context, owner, repo string, prerelease bool) (*Release, error) {
	if !prerelease {
		var r apiRelease
		if _, err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/releases/latest", nil, &r); err != nil {
			if IsNotFound(err) {
				return nil, nil
			}
			return nil, fmt.Errorf("latest release of %s/%s: %w", owner, repo, err)
		}
		return r.toRelease(), nil
	}
	var list []apiRelease
	if _, err := c.doJSON(ctx, http.MethodGet, repoPath(owner, repo)+"/releases?per_page=30", nil, &list); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("releases of %s/%s: %w", owner, repo, err)
	}
	var best *Release
	for _, r := range list {
		if r.Draft {
			continue
		}
		rel := r.toRelease()
		if best == nil || rel.PublishedAt.After(best.PublishedAt) {
			best = rel
		}
	}
	return best, nil
}
