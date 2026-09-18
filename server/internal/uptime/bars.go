// Package uptime runs availability checks (host, docker, http, tcp),
// tracks incidents and computes uptime percentages and bars.
package uptime

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"dockhand/internal/model"
)

// NumBars is the number of buckets in every uptime bar chart.
const NumBars = 30

// Counts aggregates check results in a bucket or window.
type Counts struct {
	Up, Degraded, Down int
	LatencySum         float64
	LatencyN           int
}

func (c Counts) Total() int { return c.Up + c.Degraded + c.Down }

// Add merges another count.
func (c *Counts) Add(o Counts) {
	c.Up += o.Up
	c.Degraded += o.Degraded
	c.Down += o.Down
	c.LatencySum += o.LatencySum
	c.LatencyN += o.LatencyN
}

// Pct returns the availability percentage (up and degraded count as available), or -1 without data.
func (c Counts) Pct() float64 {
	t := c.Total()
	if t == 0 {
		return -1
	}
	return round2(float64(c.Up+c.Degraded) / float64(t) * 100)
}

// AvgLatency returns the average latency in ms (0 without data).
func (c Counts) AvgLatency() float64 {
	if c.LatencyN == 0 {
		return 0
	}
	return float64(int64(c.LatencySum/float64(c.LatencyN) + 0.5))
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

// WindowDuration parses "24h" / "7d" / "30d" (default 24h).
func WindowDuration(w string) (string, time.Duration) {
	switch w {
	case "7d":
		return w, 7 * 24 * time.Hour
	case "30d":
		return w, 30 * 24 * time.Hour
	}
	return "24h", 24 * time.Hour
}

// BucketIndex returns the bucket of t in a window starting at from, or -1 when outside.
func BucketIndex(t, from time.Time, size time.Duration, n int) int {
	if t.Before(from) {
		return -1
	}
	i := int(t.Sub(from) / size)
	if i >= n {
		if i == n && t.Sub(from) == size*time.Duration(n) {
			return n - 1
		}
		return -1
	}
	return i
}

// BucketStatus derives a bar's status from its counts.
func BucketStatus(c Counts) string {
	switch {
	case c.Total() == 0:
		return "none"
	case c.Down == c.Total():
		return "down"
	case c.Down > 0 || c.Degraded > 0:
		return "degraded"
	}
	return "up"
}

// BuildBars renders n bars from bucket counts, oldest first.
func BuildBars(buckets map[int]Counts, from time.Time, size time.Duration, n int) []model.UptimeBar {
	out := make([]model.UptimeBar, n)
	for i := 0; i < n; i++ {
		c := buckets[i]
		pct := c.Pct()
		if pct < 0 {
			pct = 0
		}
		out[i] = model.UptimeBar{Status: BucketStatus(c), Pct: pct, From: from.Add(size * time.Duration(i)), To: from.Add(size * time.Duration(i+1))}
	}
	return out
}

// ParseExpect parses an expected status spec like "200", "200-399" or "200,204,301-302".
func ParseExpect(spec string) (func(int) bool, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		spec = "200-399"
	}
	type rng struct{ lo, hi int }
	var rs []rng
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lo, hi, isRange := strings.Cut(part, "-")
		a, err := strconv.Atoi(strings.TrimSpace(lo))
		if err != nil {
			return nil, fmt.Errorf("invalid expected status %q", part)
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(strings.TrimSpace(hi)); err != nil {
				return nil, fmt.Errorf("invalid expected status %q", part)
			}
		}
		if a < 100 || b > 599 || a > b {
			return nil, fmt.Errorf("invalid expected status %q", part)
		}
		rs = append(rs, rng{a, b})
	}
	if len(rs) == 0 {
		return nil, fmt.Errorf("invalid expected status %q", spec)
	}
	return func(code int) bool {
		for _, r := range rs {
			if code >= r.lo && code <= r.hi {
				return true
			}
		}
		return false
	}, nil
}
