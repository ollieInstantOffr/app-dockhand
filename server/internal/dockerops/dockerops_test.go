package dockerops

import (
	"testing"
	"time"
)

func TestIsSecretEnv(t *testing.T) {
	secret := map[string]string{
		"POSTGRES_PASSWORD": "x", "DB_PASS": "x", "API_KEY": "x", "GITHUB_TOKEN": "x", "SECRET_KEY_BASE": "x",
		"AWS_SECRET_ACCESS_KEY": "x", "JWT_SIGNING_KEY": "x", "PAPERLESS_DBPASS": "x", "MYSQL_ROOT_PASSWORD": "x",
		"SENTRY_DSN": "https://abc@sentry.io/1", "DATABASE_URL": "postgres://app:hunter2@db:5432/app", "AUTH_SECRET": "x",
		"PRIVATE_KEY": "x", "KEY": "x",
	}
	for k, v := range secret {
		if !IsSecretEnv(k, v) {
			t.Errorf("%s should be secret", k)
		}
	}
	plain := map[string]string{
		"PATH": "/usr/bin", "TZ": "UTC", "PUID": "1000", "POSTGRES_PASSWORD_FILE": "/run/secrets/pw", "NODE_ENV": "production",
		"DATABASE_URL": "postgres://db:5432/app", "KEYBOARD_LAYOUT": "us", "HOSTNAME": "web", "AUTHOR_NAME": "me",
	}
	for k, v := range plain {
		if IsSecretEnv(k, v) {
			t.Errorf("%s=%s should not be secret", k, v)
		}
	}
}

func TestNormalizeRef(t *testing.T) {
	cases := map[string]string{
		"nginx":                     "nginx:latest",
		"nginx:1.27":                "nginx:1.27",
		"localhost:5000/app":        "localhost:5000/app:latest",
		"ghcr.io/org/app:v1":        "ghcr.io/org/app:v1",
		"nginx@sha256:abc":          "nginx@sha256:abc",
		"registry.local:5000/a/b:c": "registry.local:5000/a/b:c",
	}
	for in, want := range cases {
		if got := NormalizeRef(in); got != want {
			t.Errorf("NormalizeRef(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseImageRef(t *testing.T) {
	cases := []struct {
		in                  string
		registry, repo, tag string
	}{
		{"nginx", "registry-1.docker.io", "library/nginx", "latest"},
		{"nginx:1.27", "registry-1.docker.io", "library/nginx", "1.27"},
		{"linuxserver/plex", "registry-1.docker.io", "linuxserver/plex", "latest"},
		{"docker.io/library/redis:7", "registry-1.docker.io", "library/redis", "7"},
		{"ghcr.io/paperless-ngx/paperless-ngx:2.0", "ghcr.io", "paperless-ngx/paperless-ngx", "2.0"},
		{"localhost:5000/app", "localhost:5000", "app", "latest"},
	}
	for _, c := range cases {
		r := ParseImageRef(c.in)
		if r.Registry != c.registry || r.Repo != c.repo || r.Tag != c.tag {
			t.Errorf("ParseImageRef(%q) = %+v", c.in, r)
		}
	}
}

func TestParseLogLine(t *testing.T) {
	l := parseLogLine("2026-09-18T10:11:12.123456789Z hello world", "stdout")
	if l.Line != "hello world" || l.Stream != "stdout" || l.T.Year() != 2026 || l.T.Nanosecond() != 123456789 {
		t.Errorf("parsed = %+v", l)
	}
	l = parseLogLine("no timestamp here\r", "stderr")
	if l.Line != "no timestamp here" || l.Stream != "stderr" || time.Since(l.T) > time.Minute {
		t.Errorf("fallback = %+v", l)
	}
}

func TestComposeFileArgs(t *testing.T) {
	if got := ComposeFileArgs("/a/compose.yml,/a/override.yml"); got != " -f '/a/compose.yml' -f '/a/override.yml'" {
		t.Errorf("got %q", got)
	}
	if ComposeFileArgs("") != "" {
		t.Error("empty label")
	}
}
