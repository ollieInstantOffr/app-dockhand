// Package config reads Dockhand's runtime configuration from the environment.
package config

import (
	"crypto/sha256"
	"os"
	"strconv"
	"strings"
)

// Version is overridden at build time via -ldflags "-X dockhand/internal/config.Version=…".
var Version = "1.0.3"

type Config struct {
	DatabaseURL string
	Secret      []byte // 32-byte AES key derived from DOCKHAND_SECRET
	Listen      string
	WebURL      string
	PublicURL   string
	StacksDir   string
	BackupsDir  string
	Version     string
	AutoLocal   bool

	GitHubOAuthClientID string
	GitHubAppID         int64
	GitHubAppSlug       string
	GitHubAppKey        []byte
	// MCPPort is the dedicated MCP port docker-compose publishes (DOCKHAND_MCP_PORT, 0 = none).
	MCPPort int
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// Load reads the environment. It never fails; missing secrets are reported by Validate.
func Load() *Config {
	sum := sha256.Sum256([]byte(os.Getenv("DOCKHAND_SECRET")))
	c := &Config{
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		Secret:              sum[:],
		Listen:              env("DOCKHAND_LISTEN", ":8080"),
		WebURL:              env("DOCKHAND_WEB_URL", "http://web:3000"),
		PublicURL:           strings.TrimRight(env("DOCKHAND_PUBLIC_URL", "http://localhost:5773"), "/"),
		StacksDir:           strings.TrimRight(env("DOCKHAND_STACKS_DIR", "/opt/dockhand/stacks"), "/"),
		BackupsDir:          strings.TrimRight(env("DOCKHAND_BACKUPS_DIR", "/opt/dockhand/backups"), "/"),
		Version:             env("DOCKHAND_VERSION", Version),
		AutoLocal:           strings.EqualFold(os.Getenv("DOCKHAND_AUTO_LOCAL"), "true"),
		GitHubOAuthClientID: os.Getenv("GITHUB_OAUTH_CLIENT_ID"),
		GitHubAppSlug:       os.Getenv("GITHUB_APP_SLUG"),
	}
	if p, err := strconv.Atoi(os.Getenv("DOCKHAND_MCP_PORT")); err == nil && p >= 1024 && p <= 65535 {
		c.MCPPort = p
	}
	if id, err := strconv.ParseInt(os.Getenv("GITHUB_APP_ID"), 10, 64); err == nil {
		c.GitHubAppID = id
	}
	if k := os.Getenv("GITHUB_APP_PRIVATE_KEY"); k != "" {
		c.GitHubAppKey = []byte(strings.ReplaceAll(k, `\n`, "\n"))
	} else if f := os.Getenv("GITHUB_APP_PRIVATE_KEY_FILE"); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			c.GitHubAppKey = b
		}
	}
	return c
}

// SecretSet reports whether DOCKHAND_SECRET was provided.
func SecretSet() bool { return os.Getenv("DOCKHAND_SECRET") != "" }

// SecretIsPlaceholder reports whether DOCKHAND_SECRET is the value shipped in .env.example.
func SecretIsPlaceholder() bool {
	return strings.TrimSpace(os.Getenv("DOCKHAND_SECRET")) == "change-me-to-a-long-random-string"
}

// AppConfigured reports whether GitHub App credentials are present.
func (c *Config) AppConfigured() bool { return c.GitHubAppID != 0 && len(c.GitHubAppKey) > 0 }

// LocalDockerSocket is where the local Docker daemon socket is expected.
const LocalDockerSocket = "/var/run/docker.sock"

// HasLocalDocker reports whether the local Docker socket exists.
func HasLocalDocker() bool {
	_, err := os.Stat(LocalDockerSocket)
	return err == nil
}
