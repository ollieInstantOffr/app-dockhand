// Package util holds small helpers shared across packages.
package util

import (
	"fmt"
	"strings"
	"time"
)

// NZ returns s, or an empty non-nil slice when s is nil (so JSON renders []).
func NZ[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// Shq single-quotes s for a POSIX shell.
func Shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Elapsed formats a duration like "2.4s" / "340ms" / "1m12s".
func Elapsed(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	default:
		d = d.Round(time.Second)
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
}

// HumanBytes renders a byte count like "12.4MB".
func HumanBytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "kMGTPE"[exp])
}

// Truncate shortens s to n runes with an ellipsis.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// Ptr returns a pointer to v.
func Ptr[T any](v T) *T { return &v }

// TimePtr returns nil for the zero time.
func TimePtr(t time.Time) *time.Time {
	if t.IsZero() || t.Unix() <= 0 {
		return nil
	}
	return &t
}

// Contains reports whether s contains v.
func Contains[T comparable](s []T, v T) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
