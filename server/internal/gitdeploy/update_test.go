package gitdeploy

import (
	"reflect"
	"testing"
)

func TestArchiveFiles(t *testing.T) {
	out := "org-app-1a2b3c/\norg-app-1a2b3c/docker-compose.yml\norg-app-1a2b3c/src/\norg-app-1a2b3c/src/main.go\nx org-app-1a2b3c/README.md\norg-app-1a2b3c/../evil\n"
	got := archiveFiles(out)
	want := []string{"docker-compose.yml", "src/main.go", "README.md"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("archiveFiles = %v, want %v", got, want)
	}
}

func TestArchiveFilesRefusesUnknownLayout(t *testing.T) {
	// A tar that already stripped the top folder would list files from different roots.
	if got := archiveFiles("docker-compose.yml\nsrc/main.go\nREADME.md\n"); got != nil {
		t.Fatalf("expected nil for a listing without one top folder, got %v", got)
	}
}

func TestRemoteName(t *testing.T) {
	cases := map[string]string{
		"git@github.com:org/app.git":                   "github.com/org/app",
		"https://github.com/org/app":                   "github.com/org/app",
		"https://token:x-oauth@github.com/org/app.git": "github.com/org/app",
		"ssh://git@gitlab.com/group/app.git":           "gitlab.com/group/app",
	}
	for in, want := range cases {
		if got := remoteName(in); got != want {
			t.Errorf("remoteName(%q) = %q, want %q", in, got, want)
		}
	}
}
