package dockerops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"dockhand/internal/model"
	"dockhand/internal/regauth"
)

var registryHTTP = &http.Client{Timeout: 12 * time.Second}

// ImageRef is a parsed image reference.
type ImageRef struct {
	Registry string // "registry-1.docker.io", "ghcr.io", …
	Repo     string // "library/nginx"
	Tag      string
}

// ParseImageRef splits "ghcr.io/org/app:1.2" into its parts (Docker Hub defaults applied).
func ParseImageRef(s string) ImageRef {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[:i]
	}
	r := ImageRef{Registry: "registry-1.docker.io", Tag: "latest"}
	slash := strings.LastIndex(s, "/")
	if i := strings.LastIndex(s, ":"); i > slash {
		r.Tag = s[i+1:]
		s = s[:i]
	}
	parts := strings.SplitN(s, "/", 2)
	if len(parts) == 2 && (strings.ContainsAny(parts[0], ".:") || parts[0] == "localhost") {
		r.Registry = parts[0]
		s = parts[1]
		if r.Registry == "docker.io" || r.Registry == "index.docker.io" {
			r.Registry = "registry-1.docker.io"
		}
	}
	if r.Registry == "registry-1.docker.io" && !strings.Contains(s, "/") {
		s = "library/" + s
	}
	r.Repo = s
	return r
}

// TagInfo is one tag in the tags response.
type TagInfo struct {
	Name      string     `json:"name"`
	UpdatedAt *time.Time `json:"updatedAt"`
	Size      int64      `json:"size"`
}

// Tags lists tags for an image (Docker Hub with dates/sizes, other registries names only). Best effort.
func Tags(ctx context.Context, img string) []TagInfo {
	ref := ParseImageRef(img)
	out := []TagInfo{}
	if ref.Registry == "registry-1.docker.io" {
		u := "https://hub.docker.com/v2/repositories/" + ref.Repo + "/tags?page_size=25&ordering=last_updated"
		var resp struct {
			Results []struct {
				Name        string     `json:"name"`
				LastUpdated *time.Time `json:"last_updated"`
				FullSize    int64      `json:"full_size"`
			} `json:"results"`
		}
		if getJSON(ctx, u, "", &resp) == nil {
			for _, r := range resp.Results {
				out = append(out, TagInfo{Name: r.Name, UpdatedAt: r.LastUpdated, Size: r.FullSize})
			}
		}
		return out
	}
	tok := registryToken(ctx, ref)
	var resp struct {
		Tags []string `json:"tags"`
	}
	if getJSON(ctx, registryBase(ref)+"/v2/"+ref.Repo+"/tags/list?n=200", tok, &resp) == nil {
		sort.Sort(sort.Reverse(sort.StringSlice(resp.Tags)))
		for i, t := range resp.Tags {
			if i >= 50 {
				break
			}
			out = append(out, TagInfo{Name: t})
		}
	}
	return out
}

// SearchResult is one Docker Hub repository search hit.
type SearchResult struct {
	Name        string `json:"name"` // "nginx", "grafana/grafana"
	Description string `json:"description"`
	Stars       int    `json:"stars"`
	Pulls       int64  `json:"pulls"`
	Official    bool   `json:"official"`
	Private     bool   `json:"private,omitempty"` // from Dockhand's own registry
}

// Search queries Docker Hub's public repository search. Best effort: errors yield an empty list.
func Search(ctx context.Context, q string, limit int) []SearchResult {
	out := []SearchResult{}
	q = strings.TrimSpace(q)
	if q == "" {
		return out
	}
	if limit <= 0 || limit > 25 {
		limit = 8
	}
	u := fmt.Sprintf("https://hub.docker.com/v2/search/repositories/?query=%s&page_size=%d", url.QueryEscape(q), limit)
	var resp struct {
		Results []struct {
			RepoName         string `json:"repo_name"`
			ShortDescription string `json:"short_description"`
			StarCount        int    `json:"star_count"`
			PullCount        int64  `json:"pull_count"`
			IsOfficial       bool   `json:"is_official"`
		} `json:"results"`
	}
	if getJSON(ctx, u, "", &resp) != nil {
		return out
	}
	for _, r := range resp.Results {
		name := strings.TrimPrefix(r.RepoName, "library/")
		if name == "" {
			continue
		}
		out = append(out, SearchResult{Name: name, Description: r.ShortDescription, Stars: r.StarCount, Pulls: r.PullCount, Official: r.IsOfficial})
	}
	return out
}

// InspectResult is the registry image inspect response.
type InspectResult struct {
	Size         int64      `json:"size"`
	ExposedPorts []string   `json:"exposedPorts"`
	Volumes      []string   `json:"volumes"`
	Env          []model.KV `json:"env"`
}

// InspectRemote reads an image's config from its registry (anonymous). Best effort.
func InspectRemote(ctx context.Context, img string) InspectResult {
	res := InspectResult{ExposedPorts: []string{}, Volumes: []string{}, Env: []model.KV{}}
	ref := ParseImageRef(img)
	tok := registryToken(ctx, ref)
	base := registryBase(ref) + "/v2/" + ref.Repo
	accept := strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", ")
	var man struct {
		MediaType string `json:"mediaType"`
		Manifests []struct {
			Digest   string `json:"digest"`
			Platform struct {
				OS           string `json:"os"`
				Architecture string `json:"architecture"`
			} `json:"platform"`
		} `json:"manifests"`
		Config struct {
			Digest string `json:"digest"`
			Size   int64  `json:"size"`
		} `json:"config"`
		Layers []struct {
			Size int64 `json:"size"`
		} `json:"layers"`
	}
	if err := getJSONAccept(ctx, base+"/manifests/"+ref.Tag, tok, accept, &man); err != nil {
		return res
	}
	if len(man.Manifests) > 0 {
		digest := man.Manifests[0].Digest
		for _, m := range man.Manifests {
			if m.Platform.OS == "linux" && m.Platform.Architecture == "amd64" {
				digest = m.Digest
				break
			}
		}
		man.Manifests = nil
		if err := getJSONAccept(ctx, base+"/manifests/"+digest, tok, accept, &man); err != nil {
			return res
		}
	}
	for _, l := range man.Layers {
		res.Size += l.Size
	}
	if man.Config.Digest == "" {
		return res
	}
	var cfg struct {
		Config struct {
			ExposedPorts map[string]struct{} `json:"ExposedPorts"`
			Volumes      map[string]struct{} `json:"Volumes"`
			Env          []string            `json:"Env"`
		} `json:"config"`
	}
	if err := getJSON(ctx, base+"/blobs/"+man.Config.Digest, tok, &cfg); err != nil {
		return res
	}
	for p := range cfg.Config.ExposedPorts {
		res.ExposedPorts = append(res.ExposedPorts, p)
	}
	sort.Strings(res.ExposedPorts)
	for v := range cfg.Config.Volumes {
		res.Volumes = append(res.Volumes, v)
	}
	sort.Strings(res.Volumes)
	for _, e := range cfg.Config.Env {
		k, v, _ := strings.Cut(e, "=")
		if k == "PATH" {
			continue
		}
		res.Env = append(res.Env, model.KV{K: k, V: v})
	}
	return res
}

// registryBase is where Dockhand talks to ref's registry: its own registry
// service directly, otherwise https://<registry>.
func registryBase(ref ImageRef) string {
	if u := regauth.Internal(ref.Registry + "/x"); u != "" {
		return u
	}
	return "https://" + ref.Registry
}

// registryToken returns an Authorization value for reading ref from its
// registry: a pull token from the WWW-Authenticate challenge (with saved
// credentials when there are any), Basic auth for registries that ask for it,
// or "" for none.
func registryToken(ctx context.Context, ref ImageRef) string {
	if regauth.Internal(ref.Registry+"/x") != "" {
		return "" // Dockhand's own registry, reached directly
	}
	basic := regauth.BasicHeader(ctx, ref.Registry+"/x")
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+ref.Registry+"/v2/", nil)
	resp, err := registryHTTP.Do(req)
	if err != nil {
		return ""
	}
	resp.Body.Close()
	ch := resp.Header.Get("Www-Authenticate")
	if strings.HasPrefix(strings.ToLower(ch), "basic") {
		return basic
	}
	if !strings.HasPrefix(strings.ToLower(ch), "bearer ") {
		return ""
	}
	params := map[string]string{}
	for _, p := range splitChallenge(ch[len("bearer "):]) {
		k, v, ok := strings.Cut(p, "=")
		if ok {
			params[strings.ToLower(strings.TrimSpace(k))] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	realm := params["realm"]
	if realm == "" {
		return ""
	}
	q := url.Values{}
	if params["service"] != "" {
		q.Set("service", params["service"])
	}
	q.Set("scope", "repository:"+ref.Repo+":pull")
	var tok struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := getJSON(ctx, realm+"?"+q.Encode(), basic, &tok); err != nil {
		return ""
	}
	if tok.Token != "" {
		return "Bearer " + tok.Token
	}
	if tok.AccessToken != "" {
		return "Bearer " + tok.AccessToken
	}
	return ""
}

func splitChallenge(s string) []string {
	var out []string
	var cur strings.Builder
	inQ := false
	for _, r := range s {
		switch {
		case r == '"':
			inQ = !inQ
			cur.WriteRune(r)
		case r == ',' && !inQ:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func getJSON(ctx context.Context, u, token string, dst any) error {
	return getJSONAccept(ctx, u, token, "application/json", dst)
}

func getJSONAccept(ctx context.Context, u, token, accept string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "Dockhand")
	if token != "" {
		// token is a full Authorization value ("Bearer …" / "Basic …").
		req.Header.Set("Authorization", token)
	}
	resp, err := registryHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return errors.New("empty response")
	}
	return json.Unmarshal(b, dst)
}
