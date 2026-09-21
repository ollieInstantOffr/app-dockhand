package machines

import "testing"

func TestClassify(t *testing.T) {
	units := map[string]bool{"nginx": true, "postgresql": true}
	cases := []struct {
		pkg  string
		kind string
		svc  string
	}{
		{"linux-image-6.8.0-45-generic", "reboot", ""},
		{"linux-headers-6.8.0-45", "none", ""},
		{"docker-ce", "docker", ""},
		{"docker-ce-cli", "none", ""}, // the CLI alone doesn't restart the daemon
		{"docker-compose-plugin", "none", ""},
		{"containerd.io", "docker", ""},
		{"libc6", "services", ""},
		{"libssl3", "services", ""},
		{"openssh-server", "ssh", ""},
		{"nginx-common", "services", "nginx"}, // matches a running unit
		{"postgresql-16", "services", "postgresql"},
		{"cowsay", "none", ""},
	}
	for _, c := range cases {
		e, svc := classify(c.pkg, units)
		if e.kind != c.kind || svc != c.svc {
			t.Errorf("classify(%q) = (%q, %q), want (%q, %q)", c.pkg, e.kind, svc, c.kind, c.svc)
		}
	}
}

func TestServiceFor(t *testing.T) {
	units := map[string]bool{"nginx": true, "ssh": true}
	if got := serviceFor("nginx-full", units); got != "nginx" {
		t.Errorf("nginx-full → %q", got)
	}
	if got := serviceFor("unrelated-thing", units); got != "" {
		t.Errorf("unrelated-thing → %q", got)
	}
}
