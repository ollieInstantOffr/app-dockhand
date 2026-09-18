package deploycheck

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"dockhand/internal/model"
)

func ports(hp []HostPort) []string {
	out := []string{}
	for _, p := range hp {
		out = append(out, p.key())
	}
	sort.Strings(out)
	return out
}

func TestComposeHostPorts(t *testing.T) {
	content := `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
      - "127.0.0.1:8443:443/tcp"
      - "53:53/udp"
      - "9000"
      - "${WEB_PORT:-3000}:3000"
      - "[::1]:6000:6000"
      - "::7000"
  db:
    image: postgres
    ports:
      - target: 5432
        published: "5433"
      - target: 9999
        published: 9100-9101
        protocol: udp
      - target: 1
  bad:
    ports:
      - "${UNSET}:80"
      - "abc:80"
`
	got := ports(ComposeHostPorts([]byte(content), map[string]string{}))
	want := []string{"3000/tcp", "53/udp", "5433/tcp", "6000/tcp", "8080/tcp", "8443/tcp", "9100/udp", "9101/udp"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	got = ports(ComposeHostPorts([]byte("services:\n  a:\n    ports: [\"${P}:80\"]\n"), map[string]string{"P": "8181"}))
	if !reflect.DeepEqual(got, []string{"8181/tcp"}) {
		t.Fatalf("env interpolation: %v", got)
	}
	if ComposeHostPorts([]byte(":::not yaml"), nil) != nil {
		t.Fatal("invalid yaml should yield nil")
	}
}

func TestInterpolate(t *testing.T) {
	env := map[string]string{"A": "1", "E": ""}
	cases := map[string]string{
		"${A}": "1", "$A": "1", "${B:-x}": "x", "${E:-x}": "x", "${E-x}": "", "${B-x}": "x",
		"${A:+y}": "y", "${B:+y}": "", "$$A": "$A", "${B}": "", "p${A}q": "p1q",
	}
	for in, want := range cases {
		if got := Interpolate(in, env); got != want {
			t.Errorf("Interpolate(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFormHostPorts(t *testing.T) {
	got := FormHostPorts([]model.PortPair{
		{Host: "8080", Container: "80"}, {Host: "127.0.0.1:9090", Container: "90/udp"}, {Host: "", Container: "22"},
		{Host: "7000-7001", Container: "7000-7001"}, {Host: "x", Container: "1"},
	})
	if want := []string{"7000/tcp", "7001/tcp", "8080/tcp", "9090/udp"}; !reflect.DeepEqual(ports(got), want) {
		t.Fatalf("got %v", ports(got))
	}
	for _, p := range got {
		if p.Port == 9090 && p.Raw != "127.0.0.1:9090" {
			t.Errorf("raw = %q", p.Raw)
		}
		if p.Port == 7000 && !p.Range {
			t.Error("range flag lost")
		}
	}
}

func TestNextFreePort(t *testing.T) {
	taken := map[int]bool{8080: true, 8081: true, 8082: true}
	if got := NextFreePort(8080, taken); got != 8083 {
		t.Fatalf("got %d", got)
	}
	if got := NextFreePort(65535, nil); got != 0 {
		t.Fatalf("got %d", got)
	}
}

func TestNextFreeName(t *testing.T) {
	if got := NextFreeName("web", map[string]bool{"web": true, "web-2": true, "web-3": true}); got != "web-4" {
		t.Fatalf("got %s", got)
	}
	if got := NextFreeName("web", map[string]bool{"web": true}); got != "web-2" {
		t.Fatalf("got %s", got)
	}
}

func TestParseListening(t *testing.T) {
	ss := `LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*
LISTEN 0      4096            [::]:22           [::]:*
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
LISTEN 0      511                *:8080            *:*
`
	if got := ParseListening(ss); !reflect.DeepEqual(got, map[int]bool{22: true, 53: true, 8080: true}) {
		t.Fatalf("ss: %v", got)
	}
	netstat := `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 0.0.0.0:5432            0.0.0.0:*               LISTEN
tcp6       0      0 :::80                   :::*                    LISTEN
`
	if got := ParseListening(netstat); !reflect.DeepEqual(got, map[int]bool{5432: true, 80: true}) {
		t.Fatalf("netstat: %v", got)
	}
	if got := ParseListening("sh: ss: not found\n"); len(got) != 0 {
		t.Fatalf("garbage: %v", got)
	}
}

func TestSecretKeyAndGenerate(t *testing.T) {
	for _, k := range []string{"DB_PASSWORD", "JWT_SECRET", "GITHUB_TOKEN", "API_KEY"} {
		if !IsSecretKey(k) {
			t.Errorf("%s should be a secret", k)
		}
	}
	for _, k := range []string{"TZ", "PORT", "PUID"} {
		if IsSecretKey(k) {
			t.Errorf("%s should not be a secret", k)
		}
	}
	a, b := GenerateSecret(), GenerateSecret()
	if len(a) != 32 || a == b || strings.ContainsAny(a, "+/=") {
		t.Fatalf("bad secret %q", a)
	}
}

func TestEnvIssues(t *testing.T) {
	iss := envIssues([]model.KV{{K: "TZ", V: "UTC"}, {K: "DB_PASSWORD", V: " "}}, []string{"TZ", "DB_PASSWORD", "SITE_URL", "SITE_URL"})
	if len(iss) != 2 {
		t.Fatalf("got %+v", iss)
	}
	if iss[0].Field != "DB_PASSWORD" || iss[0].Fix == nil || len(iss[0].Fix.Patch.Env) != 1 || iss[0].Fix.Patch.Env[0].K != "DB_PASSWORD" {
		t.Errorf("secret fix: %+v", iss[0])
	}
	if iss[1].Field != "SITE_URL" || iss[1].Fix != nil || iss[1].Text != "required by .env.example" {
		t.Errorf("plain: %+v", iss[1])
	}
}

func TestNameAndImageIssues(t *testing.T) {
	if iss := nameIssues(model.DeployCheckInput{Kind: "image", Name: "-bad"}); len(iss) != 1 || iss[0].Severity != "crit" {
		t.Fatalf("got %+v", iss)
	}
	if iss := nameIssues(model.DeployCheckInput{Kind: "image", Name: "My.App"}); len(iss) != 0 {
		t.Fatalf("image names may be mixed case: %+v", iss)
	}
	iss := nameIssues(model.DeployCheckInput{Kind: "compose", Name: "My.App"})
	if len(iss) != 1 || iss[0].Fix == nil || iss[0].Fix.Patch.Name != "my-app" {
		t.Fatalf("compose rename fix: %+v", iss)
	}
	if imageIssue("nginx:1.27") != nil || imageIssue("ghcr.io/org/app@sha256:"+strings.Repeat("a", 64)) != nil {
		t.Fatal("valid refs flagged")
	}
	if imageIssue("Nginx:latest") == nil || imageIssue("nginx::1") == nil || imageIssue("") == nil {
		t.Fatal("invalid refs accepted")
	}
}

func TestDiskIssue(t *testing.T) {
	if diskIssue(89.9, "h") != nil || diskIssue(90, "h").Severity != "warn" || diskIssue(97, "h").Severity != "crit" {
		t.Fatal("thresholds")
	}
}

func TestConflictIssues(t *testing.T) {
	f := hostFacts{
		containers: []ctrInfo{
			{Name: "web", Ports: []HostPort{{Port: 8080, Proto: "tcp"}}},
			{Name: "app-web-1", Stack: "app", WorkDir: "/opt/dockhand/stacks/app", Ports: []HostPort{{Port: 3000, Proto: "tcp"}}},
			{Name: "other", Ports: []HostPort{{Port: 8081, Proto: "tcp"}}},
		},
		stackPaths: map[string]string{"app": "/opt/dockhand/stacks/app"},
		listening:  map[int]bool{22: true, 8080: true, 3000: true, 8082: true},
		pathKind:   "nonempty", pathKnown: true,
	}

	// Image: name conflict + port conflicts with a container and with a host socket.
	iss := conflictIssues(model.DeployCheckInput{Kind: "image", Name: "web",
		Ports: []model.PortPair{{Host: "8081", Container: "80"}, {Host: "22", Container: "22"}}}, "nas", f)
	byField := map[string]model.DeployIssue{}
	for _, i := range iss {
		byField[i.Field] = i
	}
	if n := byField["Name"]; n.Severity != "crit" || n.Fix.Patch.Name != "web-2" {
		t.Errorf("name: %+v", n)
	}
	if p := byField["Port 8081"]; p.Text != "already used by other on nas" || p.Fix.Patch.Ports[0] != (model.PortPatch{From: "8081", To: "8083"}) {
		t.Errorf("port 8081: %+v", p)
	}
	if p := byField["Port 22"]; p.Text != "in use on the host" || p.Fix.Patch.Ports[0].To != "23" {
		t.Errorf("port 22: %+v", p)
	}
	if _, ok := byField["Path"]; ok {
		t.Error("image deploys have no path")
	}

	// Redeploying stack "app": its own port 3000 and directory don't count; name warns.
	iss = conflictIssues(model.DeployCheckInput{Kind: "compose", Name: "app", Path: "/opt/dockhand/stacks/app",
		ComposeFile: "services:\n  web:\n    ports: ['3000:3000']\n"}, "nas", f)
	if len(iss) != 1 || iss[0].Field != "Name" || iss[0].Severity != "warn" || iss[0].Fix.Patch.Name != "app-2" {
		t.Fatalf("redeploy: %+v", iss)
	}

	// A new stack into someone else's non-empty directory.
	iss = conflictIssues(model.DeployCheckInput{Kind: "git", Name: "blog", Path: "/opt/dockhand/stacks/app"}, "nas", f)
	if len(iss) != 1 || iss[0].Field != "Path" || iss[0].Severity != "warn" {
		t.Fatalf("path: %+v", iss)
	}

	// Unknown facts (host checks timed out) produce no issues.
	if iss := conflictIssues(model.DeployCheckInput{Kind: "image", Name: "web", Ports: []model.PortPair{{Host: "8080", Container: "80"}}}, "nas", hostFacts{}); len(iss) != 0 {
		t.Fatalf("empty facts: %+v", iss)
	}
}

func TestResultOrdering(t *testing.T) {
	r := result([]model.DeployIssue{{Field: "a", Severity: "warn"}, {Field: "b", Severity: "crit"}})
	if r.OK || r.Issues[0].Field != "b" {
		t.Fatalf("got %+v", r)
	}
	if r := result(nil); !r.OK || r.Issues == nil {
		t.Fatalf("empty: %+v", r)
	}
}

func TestParsePathProbe(t *testing.T) {
	for out, want := range map[string]string{"": "", "file\n": "file", "dir\n": "empty", "dir\ndocker-compose.yml\n": "nonempty"} {
		if got := parsePathProbe(out); got != want {
			t.Errorf("%q → %q want %q", out, got, want)
		}
	}
}
