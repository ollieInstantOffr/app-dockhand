package system

import "testing"

func TestParseGitHubRemote(t *testing.T) {
	for _, c := range []struct{ in, owner, repo string }{
		{"https://github.com/ollieInstantOffr/app-dockhand.git", "ollieInstantOffr", "app-dockhand"},
		{"https://github.com/ollieInstantOffr/app-dockhand", "ollieInstantOffr", "app-dockhand"},
		{"https://x-access-token:abc@github.com/o/r.git", "o", "r"},
		{"git@github.com:o/r.git", "o", "r"},
		{"ssh://git@github.com/o/r.git", "o", "r"},
		{"https://gitlab.com/o/r.git", "", ""},
	} {
		o, r := parseGitHubRemote(c.in)
		if o != c.owner || r != c.repo {
			t.Errorf("%s → %s/%s, want %s/%s", c.in, o, r, c.owner, c.repo)
		}
	}
}

func TestNonEmptyLinesSkipsWarnings(t *testing.T) {
	got := nonEmptyLines("warning: something\n\n0123456789abcdef0123456789abcdef01234567\nmain\nhttps://github.com/o/r.git\n")
	if len(got) != 3 || got[1] != "main" {
		t.Fatalf("got %v", got)
	}
}

func TestSplitRepo(t *testing.T) {
	if o, r := splitRepo("https://github.com/ollieInstantOffr/app-dockhand"); o != "ollieInstantOffr" || r != "app-dockhand" {
		t.Fatalf("got %s/%s", o, r)
	}
}
