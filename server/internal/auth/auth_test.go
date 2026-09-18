package auth

import "testing"

func TestParseUserAgent(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15":            "Safari · macOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36":                  "Chrome · Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0":    "Edge · Windows",
		"Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0":                                                           "Firefox · Linux",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari": "Chrome · iOS",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36":                "Chrome · Android",
		"curl/8.5.0": "curl",
		"":           "Unknown device",
	}
	for ua, want := range cases {
		if got := ParseUserAgent(ua); got != want {
			t.Errorf("ParseUserAgent(%q) = %q, want %q", ua, got, want)
		}
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(3, 60e9)
	for i := 0; i < 3; i++ {
		if !l.Allowed("ip") {
			t.Fatal("should be allowed")
		}
		l.Fail("ip")
	}
	if l.Allowed("ip") {
		t.Fatal("should be blocked")
	}
	l.Reset("ip")
	if !l.Allowed("ip") {
		t.Fatal("reset should allow")
	}
}

func TestValidatePassword(t *testing.T) {
	if ValidatePassword("short") == nil {
		t.Error("short password accepted")
	}
	if ValidatePassword("correct horse battery") != nil {
		t.Error("long password rejected")
	}
}
