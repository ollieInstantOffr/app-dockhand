package gitdeploy

import (
	"context"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"dockhand/internal/model"
)

func TestStackName(t *testing.T) {
	cases := map[string]string{"/opt/dockhand/stacks/Paperless-NGX": "paperless-ngx", "my app!": "my-app", "": "app", "/": "app", "a.b": "a-b"}
	for in, want := range cases {
		if got := StackName(in); got != want {
			t.Errorf("StackName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestQuoteEnv(t *testing.T) {
	cases := map[string]string{"plain": "plain", "": "", "has space": `"has space"`, `a"b`: `"a\"b"`, "$HOME": `"$$HOME"`}
	for in, want := range cases {
		if got := quoteEnv(in); got != want {
			t.Errorf("quoteEnv(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAPIURLFor(t *testing.T) {
	if apiURLFor("https://github.com") != "https://api.github.com" || apiURLFor("") != "https://api.github.com" {
		t.Error("github.com")
	}
	if apiURLFor("https://git.corp.example/") != "https://git.corp.example/api/v3" {
		t.Error("enterprise")
	}
}

func TestEnvHelpers(t *testing.T) {
	if got := envFile([]model.KV{{K: "A", V: "1"}, {K: "", V: "x"}, {K: "B", V: "two words"}}); got != "A=1\nB=\"two words\"\n" {
		t.Errorf("envFile = %q", got)
	}
	if got := envExampleCandidates("docker-compose.yml"); !reflect.DeepEqual(got, []string{".env.example", ".env.sample", "example.env"}) {
		t.Errorf("root candidates = %v", got)
	}
	if got := envExampleCandidates("deploy/compose.yml"); !reflect.DeepEqual(got,
		[]string{"deploy/.env.example", "deploy/.env.sample", "deploy/example.env", ".env.example"}) {
		t.Errorf("nested candidates = %v", got)
	}
}

func TestComposeConfig(t *testing.T) {
	if err := exec.Command("docker", "compose", "version").Run(); err != nil {
		t.Skip("docker compose not available")
	}
	t.Setenv("DOCKHAND_LEAK", "leaked")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	files := map[string][]byte{
		"deploy/compose.yml": []byte("services:\n  web:\n    image: nginx:${TAG}\n    build: .\n    environment:\n      LEAK: ${DOCKHAND_LEAK:-none}\n"),
		"deploy/.env":        []byte("TAG=1.27\n"),
	}
	out, ok, err := ComposeConfig(ctx, "demo", "deploy/compose.yml", files, "/opt/dockhand/stacks/demo")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v out=%s", ok, err, out)
	}
	for _, want := range []string{"nginx:1.27", "LEAK: none", "/opt/dockhand/stacks/demo/deploy", "name: demo"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "dockhand-dryrun-") {
		t.Errorf("temp dir leaked into output:\n%s", out)
	}

	files = map[string][]byte{"compose.yml": []byte("services:\n  web:\n    image: nginx:${TAG:?TAG must be set}\n")}
	out, ok, err = ComposeConfig(ctx, "demo", "compose.yml", files, "")
	if err != nil || ok || !strings.Contains(out, "TAG must be set") || !strings.Contains(out, "nginx:${TAG:?TAG must be set}") {
		t.Fatalf("required variable: ok=%v err=%v out=%s", ok, err, out)
	}

	files = map[string][]byte{"compose.yml": []byte("services: [not, a, map]\n")}
	if out, ok, err = ComposeConfig(ctx, "demo", "compose.yml", files, ""); err != nil || ok || out == "" {
		t.Fatalf("invalid file: ok=%v err=%v out=%s", ok, err, out)
	}
}
