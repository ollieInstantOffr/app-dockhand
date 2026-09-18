package uptime

import (
	"testing"
	"time"
)

func TestBucketIndex(t *testing.T) {
	from := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	size := 48 * time.Minute
	cases := []struct {
		at   time.Time
		want int
	}{
		{from.Add(-time.Second), -1},
		{from, 0},
		{from.Add(47 * time.Minute), 0},
		{from.Add(48 * time.Minute), 1},
		{from.Add(24*time.Hour - time.Second), 29},
		{from.Add(24 * time.Hour), 29},
		{from.Add(25 * time.Hour), -1},
	}
	for _, c := range cases {
		if got := BucketIndex(c.at, from, size, NumBars); got != c.want {
			t.Errorf("BucketIndex(%v) = %d, want %d", c.at.Sub(from), got, c.want)
		}
	}
}

func TestBuildBars(t *testing.T) {
	from := time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC)
	size := time.Hour
	bars := BuildBars(map[int]Counts{
		0: {Up: 10},
		1: {Up: 9, Down: 1},
		2: {Down: 5},
		3: {Up: 3, Degraded: 1},
	}, from, size, 5)
	if len(bars) != 5 {
		t.Fatalf("len = %d", len(bars))
	}
	want := []struct {
		status string
		pct    float64
	}{{"up", 100}, {"degraded", 90}, {"down", 0}, {"degraded", 100}, {"none", 0}}
	for i, w := range want {
		if bars[i].Status != w.status || bars[i].Pct != w.pct {
			t.Errorf("bar %d = %s %.2f, want %s %.2f", i, bars[i].Status, bars[i].Pct, w.status, w.pct)
		}
	}
	if !bars[1].From.Equal(from.Add(time.Hour)) || !bars[1].To.Equal(from.Add(2*time.Hour)) {
		t.Errorf("bar 1 range = %v–%v", bars[1].From, bars[1].To)
	}
}

func TestCounts(t *testing.T) {
	var c Counts
	if c.Pct() != -1 {
		t.Error("empty counts should be -1")
	}
	c.Add(Counts{Up: 2, Down: 1, LatencySum: 300, LatencyN: 2})
	if got := c.Pct(); got != 66.67 {
		t.Errorf("Pct = %v", got)
	}
	if got := c.AvgLatency(); got != 150 {
		t.Errorf("AvgLatency = %v", got)
	}
}

func TestWindowDuration(t *testing.T) {
	if w, d := WindowDuration("7d"); w != "7d" || d != 7*24*time.Hour {
		t.Error("7d")
	}
	if w, d := WindowDuration("bogus"); w != "24h" || d != 24*time.Hour {
		t.Error("default")
	}
}

func TestParseExpect(t *testing.T) {
	f, err := ParseExpect("")
	if err != nil || !f(200) || !f(301) || f(404) {
		t.Error("default range 200-399")
	}
	f, err = ParseExpect("200, 204, 401-403")
	if err != nil || !f(204) || !f(402) || f(201) {
		t.Error("list")
	}
	for _, bad := range []string{"abc", "500-400", "99", "200-"} {
		if _, err := ParseExpect(bad); err == nil {
			t.Errorf("ParseExpect(%q) should fail", bad)
		}
	}
}
