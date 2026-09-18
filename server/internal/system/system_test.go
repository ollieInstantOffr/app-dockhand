package system

import "testing"

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.1.9", 1}, {"v1.0.0", "1.0.0", 0}, {"1.0.0-beta.1", "1.0.0", -1}, {"1.10.0", "1.9.3", 1},
		{"2.0", "2.0.0", 0}, {"1.0.0-rc.2", "1.0.0-rc.1", 1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestReleaseNotes(t *testing.T) {
	notes := ReleaseNotes("## What's new\n- Faster polling\n* Fix logs\n\nSome prose\n  + Nested item\n-\n")
	if len(notes) != 3 || notes[0] != "Faster polling" || notes[2] != "Nested item" {
		t.Errorf("notes = %q", notes)
	}
}
