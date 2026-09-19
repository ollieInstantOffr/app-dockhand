package regauth

import (
	"encoding/json"
	"testing"
)

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"nginx":                          "docker.io",
		"grafana/grafana:11":             "docker.io",
		"docker.io/library/nginx":        "docker.io",
		"ghcr.io/org/app:1.2":            "ghcr.io",
		"dockhand.lan:5773/myapp:latest": "dockhand.lan:5773",
		"localhost:5773/x":               "localhost:5773",
		"localhost/x":                    "localhost",
	}
	for in, want := range cases {
		if got := HostOf(in); got != want {
			t.Errorf("HostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMerge(t *testing.T) {
	out := MergeDockerConfig([]byte(`{"credsStore":"desktop","auths":{"quay.io":{}}}`), []Cred{{Server: "ghcr.io", Username: "u", Password: "p"}, {Server: "docker.io", Username: "a", Password: "b"}})
	var cfg struct {
		CredsStore  string                       `json:"credsStore"`
		Auths       map[string]map[string]string `json:"auths"`
		CredHelpers map[string]string            `json:"credHelpers"`
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.CredsStore != "desktop" || cfg.Auths["ghcr.io"]["auth"] != "dTpw" || cfg.Auths["https://index.docker.io/v1/"]["auth"] == "" {
		t.Fatalf("bad merge: %s", out)
	}
	if _, ok := cfg.Auths["quay.io"]; !ok {
		t.Fatal("dropped existing auth")
	}
	if h, ok := cfg.CredHelpers["ghcr.io"]; !ok || h != "" {
		t.Fatal("missing credHelpers override")
	}
	if _, ok := cfg.CredHelpers["index.docker.io"]; !ok {
		t.Fatal("missing docker hub credHelpers override")
	}
}
