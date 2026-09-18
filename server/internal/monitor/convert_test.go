package monitor

import (
	"testing"

	"github.com/docker/docker/api/types/container"
)

func TestHealthAndExit(t *testing.T) {
	cases := []struct {
		status, health string
		exit           int
	}{
		{"Up 3 days (healthy)", "healthy", 0},
		{"Up 2 minutes (unhealthy)", "unhealthy", 0},
		{"Up 5 seconds (health: starting)", "starting", 0},
		{"Up 1 hour", "none", 0},
		{"Exited (137) 3 hours ago", "none", 137},
		{"Exited (0) About a minute ago", "none", 0},
	}
	for _, c := range cases {
		if got := HealthFromStatus(c.status); got != c.health {
			t.Errorf("HealthFromStatus(%q) = %q", c.status, got)
		}
		if got := ExitCodeFromStatus(c.status); got != c.exit {
			t.Errorf("ExitCodeFromStatus(%q) = %d", c.status, got)
		}
	}
}

func TestImageTag(t *testing.T) {
	cases := map[string]string{"nginx": "latest", "nginx:1.27": "1.27", "localhost:5000/app": "latest",
		"ghcr.io/o/a:v2@sha256:abc": "v2", "registry:5000/a/b:c": "c"}
	for in, want := range cases {
		if got := ImageTag(in); got != want {
			t.Errorf("ImageTag(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPortsDedup(t *testing.T) {
	ps := Ports([]container.Port{
		{IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp"},
		{IP: "::", PrivatePort: 80, PublicPort: 8080, Type: "tcp"},
		{PrivatePort: 443, Type: "tcp"},
		{IP: "0.0.0.0", PrivatePort: 53, PublicPort: 53, Type: "udp"},
	})
	if len(ps) != 3 {
		t.Fatalf("ports = %+v", ps)
	}
	if ps[0].Container != 53 || ps[0].Proto != "udp" || ps[1].Container != 80 || ps[1].Host != 8080 || ps[2].Host != 0 {
		t.Errorf("ports = %+v", ps)
	}
}

func TestRing(t *testing.T) {
	r := newRing(3)
	for i := 1; i <= 5; i++ {
		r.push(float64(i))
	}
	s := r.snapshot()
	if len(s) != 3 || s[0] != 3 || s[2] != 5 || r.last() != 5 {
		t.Errorf("ring = %v", s)
	}
}
