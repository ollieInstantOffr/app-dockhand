package system

import (
	"testing"
	"time"
)

func TestWindow(t *testing.T) {
	loc := time.UTC
	at := func(day, h, m int) time.Time { return time.Date(2026, 9, 13+day, h, m, 0, 0, loc) } // 2026-09-13 is a Sunday
	cases := []struct {
		win  string
		t    time.Time
		want bool
	}{
		{"Sun 03:00–05:00", at(0, 3, 0), true},
		{"Sun 03:00–05:00", at(0, 4, 59), true},
		{"Sun 03:00–05:00", at(0, 5, 0), false},
		{"Sun 03:00–05:00", at(1, 3, 30), false},
		{"Daily 04:00–05:00", at(3, 4, 10), true},
		{"Daily 04:00-05:00", at(3, 6, 10), false},
		{"Sat 23:00–01:00", at(6, 23, 30), true},
		{"Sat 23:00–01:00", at(7, 0, 30), true}, // Sunday 00:30 belongs to Saturday's window
		{"Sat 23:00–01:00", at(1, 0, 30), false},
		{"Weekdays 02:00–03:00", at(2, 2, 15), true},
		{"Weekdays 02:00–03:00", at(6, 2, 15), false},
		{"Any time", at(4, 13, 0), true},
	}
	for _, c := range cases {
		w, err := parseWindow(c.win)
		if err != nil {
			t.Fatalf("%s: %v", c.win, err)
		}
		if got := w.contains(c.t); got != c.want {
			t.Errorf("%s at %s: got %v want %v", c.win, c.t.Format("Mon 15:04"), got, c.want)
		}
	}
	w, _ := parseWindow("Sun 03:00–05:00")
	if n := w.next(at(1, 12, 0)); !n.Equal(at(7, 3, 0)) {
		t.Errorf("next: got %s", n)
	}
	if _, err := parseWindow("Funday 03:00–05:00"); err == nil {
		t.Error("expected error for bad day")
	}
}
