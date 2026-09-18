package auth

import "strings"

// ParseUserAgent returns a friendly "Browser · OS" string for a User-Agent header.
func ParseUserAgent(ua string) string {
	if strings.TrimSpace(ua) == "" {
		return "Unknown device"
	}
	l := strings.ToLower(ua)
	browser := "Browser"
	switch {
	case strings.Contains(l, "edg/") || strings.Contains(l, "edga/") || strings.Contains(l, "edgios/"):
		browser = "Edge"
	case strings.Contains(l, "opr/") || strings.Contains(l, "opera"):
		browser = "Opera"
	case strings.Contains(l, "vivaldi"):
		browser = "Vivaldi"
	case strings.Contains(l, "firefox/") || strings.Contains(l, "fxios/"):
		browser = "Firefox"
	case strings.Contains(l, "crios/"):
		browser = "Chrome"
	case strings.Contains(l, "chrome/") || strings.Contains(l, "chromium/"):
		browser = "Chrome"
	case strings.Contains(l, "safari/") && strings.Contains(l, "version/"):
		browser = "Safari"
	case strings.HasPrefix(l, "curl/"):
		browser = "curl"
	}
	os := "Unknown OS"
	switch {
	case strings.Contains(l, "iphone"):
		os = "iOS"
	case strings.Contains(l, "ipad"):
		os = "iPadOS"
	case strings.Contains(l, "android"):
		os = "Android"
	case strings.Contains(l, "cros"):
		os = "ChromeOS"
	case strings.Contains(l, "mac os x") || strings.Contains(l, "macintosh"):
		os = "macOS"
	case strings.Contains(l, "windows"):
		os = "Windows"
	case strings.Contains(l, "linux"):
		os = "Linux"
	}
	if browser == "curl" {
		return "curl"
	}
	return browser + " · " + os
}
