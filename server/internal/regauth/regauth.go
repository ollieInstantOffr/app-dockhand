// Package regauth resolves registry credentials for image references. The
// registry service provides the credentials (set Src at startup); dockerops and
// the update checker use them for pulls, compose runs and digest checks.
package regauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// Cred is a username/password (or token) for one registry.
type Cred struct {
	Server   string // normalized host, e.g. "docker.io", "ghcr.io", "dockhand.lan:5773"
	Username string
	Password string
}

// Source provides stored credentials.
type Source interface {
	// Lookup returns the credential for a normalized registry host.
	Lookup(ctx context.Context, server string) (Cred, bool)
	// All returns every credential (for a temporary docker config).
	All(ctx context.Context) []Cred
	// Internal returns a base URL Dockhand can reach a registry at directly
	// (its own registry service), or "".
	Internal(server string) string
}

// Src is set by main; nil means no credentials are configured.
var Src Source

// Normalize turns "https://index.docker.io/v1/", "registry-1.docker.io" and
// friends into "docker.io", and strips schemes and paths from other servers.
func Normalize(server string) string {
	s := strings.ToLower(strings.TrimSpace(server))
	s = strings.TrimPrefix(strings.TrimPrefix(s, "https://"), "http://")
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	switch s {
	case "", "docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com", "hub.docker.com":
		return "docker.io"
	}
	return s
}

// HostOf returns the normalized registry host of an image reference.
func HostOf(ref string) string {
	ref = strings.TrimSpace(ref)
	first, _, ok := strings.Cut(ref, "/")
	if ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return Normalize(first)
	}
	return "docker.io"
}

// For returns the credential for an image reference.
func For(ctx context.Context, ref string) (Cred, bool) {
	if Src == nil {
		return Cred{}, false
	}
	return Src.Lookup(ctx, HostOf(ref))
}

// Internal returns Dockhand's direct URL for the registry of ref, or "".
func Internal(ref string) string {
	if Src == nil {
		return ""
	}
	return Src.Internal(HostOf(ref))
}

// Encoded is the X-Registry-Auth value for the Docker API ("" = anonymous).
func Encoded(ctx context.Context, ref string) string {
	c, ok := For(ctx, ref)
	if !ok {
		return ""
	}
	b, _ := json.Marshal(map[string]string{"username": c.Username, "password": c.Password, "serveraddress": dockerKey(c.Server)})
	return base64.URLEncoding.EncodeToString(b)
}

// BasicHeader is an "Authorization: Basic …" value for ref's registry, or "".
func BasicHeader(ctx context.Context, ref string) string {
	c, ok := For(ctx, ref)
	if !ok {
		return ""
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(c.Username+":"+c.Password))
}

// dockerKey is the key the docker CLI uses for a registry in config.json.
func dockerKey(server string) string {
	if server == "docker.io" {
		return "https://index.docker.io/v1/"
	}
	return server
}

// MergeDockerConfig adds creds to an existing docker config.json (which may be
// empty or invalid). Each registry also gets an empty credHelpers entry, which
// makes the CLI read it from the file even when a credsStore (desktop, pass,
// osxkeychain…) is configured for everything else.
func MergeDockerConfig(existing []byte, creds []Cred) []byte {
	cfg := map[string]any{}
	if len(strings.TrimSpace(string(existing))) > 0 {
		_ = json.Unmarshal(existing, &cfg)
	}
	auths, _ := cfg["auths"].(map[string]any)
	if auths == nil {
		auths = map[string]any{}
	}
	helpers, _ := cfg["credHelpers"].(map[string]any)
	if helpers == nil {
		helpers = map[string]any{}
	}
	for _, c := range creds {
		entry := map[string]any{"auth": base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Password))}
		keys := []string{dockerKey(c.Server)}
		if c.Server == "docker.io" {
			keys = append(keys, "docker.io", "index.docker.io", "registry-1.docker.io")
		}
		for _, k := range keys {
			auths[k] = entry
			helpers[strings.TrimSuffix(strings.TrimPrefix(k, "https://"), "/v1/")] = ""
		}
	}
	cfg["auths"] = auths
	cfg["credHelpers"] = helpers
	out, _ := json.MarshalIndent(cfg, "", "  ")
	return out
}
