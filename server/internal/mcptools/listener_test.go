package mcptools

import "testing"

func TestEndpointURL(t *testing.T) {
	cases := []struct {
		pub  string
		port int
		want string
	}{
		{"http://localhost:3000", 0, "http://localhost:3000/mcp"},
		{"https://dockhand.home.arpa/", 0, "https://dockhand.home.arpa/mcp"},
		{"http://localhost:3000", 8787, "http://localhost:8787/mcp"},
		{"https://dockhand.home.arpa", 8787, "https://dockhand.home.arpa:8787/mcp"},
		{"http://[::1]:3000/sub", 9000, "http://[::1]:9000/mcp"},
	}
	for _, c := range cases {
		if got := endpointURL(c.pub, c.port); got != c.want {
			t.Errorf("endpointURL(%q, %d) = %q, want %q", c.pub, c.port, got, c.want)
		}
	}
}
