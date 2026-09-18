// Package github is a small GitHub REST client used by Dockhand for repository
// discovery, git deploys, webhooks, the OAuth device flow and GitHub App auth.
package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultAPIURL is the public GitHub REST endpoint.
const DefaultAPIURL = "https://api.github.com"

// DefaultServerURL is the public GitHub web endpoint (device flow).
const DefaultServerURL = "https://github.com"

const requestTimeout = 30 * time.Second

// Client talks to the GitHub REST API (github.com or GitHub Enterprise).
type Client struct {
	http   *http.Client
	apiURL string
	token  string
}

// Repo is a repository as returned by the list endpoints.
type Repo struct {
	ID            int64
	Owner         string
	Name          string
	FullName      string
	Description   string
	DefaultBranch string
	Private       bool
	PushedAt      time.Time // zero when GitHub reports null
}

// Branch is a repository branch. UpdatedAt is nil because the list endpoint
// does not return commit dates (no extra per-branch calls are made).
type Branch struct {
	Name      string
	SHA       string
	UpdatedAt *time.Time
}

// Release is a GitHub release.
type Release struct {
	Tag         string
	Name        string
	Body        string
	URL         string
	Prerelease  bool
	PublishedAt time.Time
}

// APIError is returned for any non-2xx response.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("GitHub: %s (%d)", e.Message, e.Status)
}

// newHTTPClient returns a client without an overall timeout (so streaming
// bodies are bounded only by the context) but with dial / header timeouts.
func newHTTPClient() *http.Client {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: requestTimeout,
		MaxIdleConns:          20,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{Transport: tr}
}

var sharedHTTP = newHTTPClient()

// New creates a client. apiURL is "https://api.github.com" or
// "https://<ghe-host>/api/v3"; empty means api.github.com.
func New(apiURL, token string) *Client {
	return &Client{http: sharedHTTP, apiURL: normalizeAPIURL(apiURL), token: token}
}

func normalizeAPIURL(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if u == "" {
		return DefaultAPIURL
	}
	return u
}

func (c *Client) url(path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	return c.apiURL + path
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url(path), rdr)
	if err != nil {
		return nil, fmt.Errorf("GitHub: build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "Dockhand")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// send performs req and converts non-2xx responses into *APIError. On success
// the caller owns resp.Body.
func (c *Client) send(req *http.Request) (*http.Response, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		if ctxErr := req.Context().Err(); ctxErr != nil {
			return nil, fmt.Errorf("GitHub: %s %s: %w", req.Method, req.URL.Path, ctxErr)
		}
		return nil, fmt.Errorf("GitHub: %s %s: %w", req.Method, req.URL.Path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		defer resp.Body.Close()
		return nil, errorFromResponse(resp)
	}
	return resp, nil
}

// doJSON performs a JSON request with the standard 30 s timeout and decodes
// the response into out (if non-nil). It returns the response headers.
func (c *Client) doJSON(ctx context.Context, method, path string, body, out any) (http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	resp, err := c.send(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(out); err != nil && !errors.Is(err, io.EOF) {
			return resp.Header, fmt.Errorf("GitHub: decode %s: %w", req.URL.Path, err)
		}
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	}
	return resp.Header, nil
}

// getPaged follows Link rel="next" pagination, calling each for every page.
func (c *Client) getPaged(ctx context.Context, path string, each func(raw json.RawMessage) error) error {
	next := path
	for page := 0; next != "" && page < 100; page++ {
		var raw json.RawMessage
		h, err := c.doJSON(ctx, http.MethodGet, next, nil, &raw)
		if err != nil {
			return err
		}
		if err := each(raw); err != nil {
			return err
		}
		next = NextPageURL(h.Get("Link"))
	}
	return nil
}

// NextPageURL extracts the rel="next" URL from a GitHub Link header, or "".
func NextPageURL(link string) string {
	for _, part := range strings.Split(link, ",") {
		segs := strings.Split(part, ";")
		if len(segs) < 2 {
			continue
		}
		u := strings.TrimSpace(segs[0])
		if !strings.HasPrefix(u, "<") || !strings.HasSuffix(u, ">") {
			continue
		}
		for _, p := range segs[1:] {
			p = strings.TrimSpace(p)
			k, v, ok := strings.Cut(p, "=")
			if !ok || strings.TrimSpace(k) != "rel" {
				continue
			}
			for _, rel := range strings.Fields(strings.Trim(strings.TrimSpace(v), `"`)) {
				if rel == "next" {
					return u[1 : len(u)-1]
				}
			}
		}
	}
	return ""
}

func errorFromResponse(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var payload struct {
		Message          string `json:"message"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &payload)
	msg := payload.Message
	if msg == "" {
		msg = payload.ErrorDescription
	}
	if msg == "" {
		msg = payload.Error
	}
	switch {
	case msg != "":
		msg = strings.ToLower(msg[:1]) + msg[1:]
	case resp.StatusCode == http.StatusUnauthorized:
		msg = "bad credentials"
	case resp.StatusCode == http.StatusNotFound:
		msg = "not found"
	default:
		msg = strings.ToLower(http.StatusText(resp.StatusCode))
		if msg == "" {
			msg = "unexpected response"
		}
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		if resp.Header.Get("X-RateLimit-Remaining") == "0" {
			msg = "API rate limit exceeded"
			if reset, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && reset > 0 {
				msg += fmt.Sprintf("; resets at %s", time.Unix(reset, 0).UTC().Format(time.RFC3339))
			}
		} else if ra := resp.Header.Get("Retry-After"); ra != "" {
			msg += fmt.Sprintf(" (secondary rate limit; retry after %ss)", ra)
		}
	}
	return &APIError{Status: resp.StatusCode, Message: msg}
}

// IsNotFound reports whether err is a GitHub 404.
func IsNotFound(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == http.StatusNotFound
}

func esc(s string) string { return url.PathEscape(s) }

// escPath escapes each segment of a slash-separated path.
func escPath(p string) string {
	segs := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func repoPath(owner, repo string) string {
	return "/repos/" + esc(owner) + "/" + esc(repo)
}
