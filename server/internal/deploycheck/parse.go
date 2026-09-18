// Package deploycheck runs the pre-flight checks behind POST /api/deploy/check:
// name/port/path conflicts on the target host, missing required variables,
// disk pressure and obviously invalid input. The pure helpers live here; the
// host-facing part is in check.go.
package deploycheck

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"dockhand/internal/dockerops"
	"dockhand/internal/model"
)

// HostPort is a host port a deployment wants to publish.
type HostPort struct {
	Port  int
	Proto string // tcp | udp
	Raw   string // the host field as the user typed it ("8080", "127.0.0.1:8080")
	Range bool   // part of a port range (no one-click fix)
}

func (p HostPort) key() string { return fmt.Sprintf("%d/%s", p.Port, p.Proto) }

const maxRange = 256

var dockerNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// ValidDockerName reports whether n is a valid container name.
func ValidDockerName(n string) bool { return dockerNameRe.MatchString(n) }

// NextFreeName returns "<base>-N" for the smallest N ≥ 2 not in taken.
func NextFreeName(base string, taken map[string]bool) string {
	for i := 2; ; i++ {
		n := fmt.Sprintf("%s-%d", base, i)
		if !taken[n] {
			return n
		}
	}
}

// NextFreePort returns the first port > n that isn't taken (0 if none).
func NextFreePort(n int, taken map[int]bool) int {
	for p := n + 1; p <= 65535; p++ {
		if !taken[p] {
			return p
		}
	}
	return 0
}

// IsSecretKey reports whether an env key looks like a secret (shared with the
// container detail view's masking rules).
func IsSecretKey(k string) bool { return dockerops.IsSecretEnv(k, "") }

// GenerateSecret returns 32 random URL-safe characters.
func GenerateSecret() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// parsePortSpec parses "8080", "8080-8082" into ports (nil if not numeric).
func parsePortSpec(s string) ([]int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	lo, hi, isRange := strings.Cut(s, "-")
	a, err := strconv.Atoi(strings.TrimSpace(lo))
	if err != nil || a < 1 || a > 65535 {
		return nil, false
	}
	if !isRange {
		return []int{a}, false
	}
	b, err := strconv.Atoi(strings.TrimSpace(hi))
	if err != nil || b < a || b > 65535 {
		return nil, false
	}
	if b-a >= maxRange {
		b = a + maxRange - 1
	}
	out := make([]int, 0, b-a+1)
	for p := a; p <= b; p++ {
		out = append(out, p)
	}
	return out, true
}

// splitHostIP strips an optional "ip:" / "[v6]:" prefix from a host port field.
func splitHostIP(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, ":"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// FormHostPorts reads the host ports of a deploy form's port rows.
func FormHostPorts(rows []model.PortPair) []HostPort {
	var out []HostPort
	for _, r := range rows {
		proto := "tcp"
		if _, p, ok := strings.Cut(r.Container, "/"); ok && p != "" {
			proto = strings.ToLower(strings.TrimSpace(p))
		}
		host := r.Host
		if h, p, ok := strings.Cut(host, "/"); ok {
			host, proto = h, strings.ToLower(strings.TrimSpace(p))
		}
		ports, isRange := parsePortSpec(splitHostIP(host))
		for _, p := range ports {
			out = append(out, HostPort{Port: p, Proto: proto, Raw: strings.TrimSpace(r.Host), Range: isRange})
		}
	}
	return out
}

var varRe = regexp.MustCompile(`\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))`)

// Interpolate resolves compose-style ${VAR}, ${VAR:-default}, ${VAR-default},
// ${VAR:+alt} and $VAR against env. "$$" is a literal "$".
func Interpolate(s string, env map[string]string) string {
	const esc = "\x00"
	s = strings.ReplaceAll(s, "$$", esc)
	s = varRe.ReplaceAllStringFunc(s, func(m string) string {
		g := varRe.FindStringSubmatch(m)
		if g[4] != "" {
			return env[g[4]]
		}
		v, set := env[g[1]]
		switch g[2] {
		case ":-":
			if v == "" {
				return g[3]
			}
		case "-":
			if !set {
				return g[3]
			}
		case ":+":
			if v != "" {
				return g[3]
			}
			return ""
		case "+":
			if set {
				return g[3]
			}
			return ""
		}
		return v
	})
	return strings.ReplaceAll(s, esc, "$")
}

// ComposeHostPorts returns the host ports published by a Compose file, with
// variables resolved against env. Unparseable content yields nil.
func ComposeHostPorts(content []byte, env map[string]string) []HostPort {
	var doc struct {
		Services map[string]struct {
			NetworkMode string      `yaml:"network_mode"`
			Ports       []yaml.Node `yaml:"ports"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil
	}
	names := make([]string, 0, len(doc.Services))
	for n := range doc.Services {
		names = append(names, n)
	}
	sort.Strings(names)
	var out []HostPort
	for _, n := range names {
		for _, node := range doc.Services[n].Ports {
			out = append(out, composePort(&node, env)...)
		}
	}
	return out
}

func composePort(n *yaml.Node, env map[string]string) []HostPort {
	switch n.Kind {
	case yaml.MappingNode: // long syntax
		var long struct {
			Published string `yaml:"published"`
			Protocol  string `yaml:"protocol"`
		}
		if err := n.Decode(&long); err != nil {
			return nil
		}
		proto := strings.ToLower(Interpolate(long.Protocol, env))
		if proto == "" {
			proto = "tcp"
		}
		raw := strings.TrimSpace(Interpolate(long.Published, env))
		ports, isRange := parsePortSpec(raw)
		out := make([]HostPort, 0, len(ports))
		for _, p := range ports {
			out = append(out, HostPort{Port: p, Proto: proto, Raw: raw, Range: isRange})
		}
		return out
	case yaml.ScalarNode:
		s := strings.TrimSpace(Interpolate(n.Value, env))
		proto := "tcp"
		if i := strings.LastIndex(s, "/"); i >= 0 {
			s, proto = s[:i], strings.ToLower(s[i+1:])
		}
		// [ip:]host:container — drop the container part, then the ip.
		i := strings.LastIndex(s, ":")
		if i < 0 {
			return nil // container port only: nothing published on a fixed host port
		}
		host := splitHostIP(s[:i])
		if strings.HasSuffix(s[:i], "]") || host == "" { // "[::1]:80" style or "ip::80" (random host port)
			return nil
		}
		ports, isRange := parsePortSpec(host)
		out := make([]HostPort, 0, len(ports))
		for _, p := range ports {
			out = append(out, HostPort{Port: p, Proto: proto, Raw: host, Range: isRange})
		}
		return out
	}
	return nil
}

// ParseListening reads `ss -Hltn` (or `netstat -ltn`) output and returns the
// listening TCP ports. Header lines and unknown formats are ignored.
func ParseListening(out string) map[int]bool {
	ports := map[int]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		// ss: State Recv-Q Send-Q Local Peer; netstat: Proto Recv-Q Send-Q Local Foreign State.
		local := f[3]
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		p, err := strconv.Atoi(local[i+1:])
		if err != nil || p < 1 || p > 65535 {
			continue
		}
		if f[0] != "LISTEN" && !strings.HasPrefix(f[0], "tcp") {
			continue
		}
		ports[p] = true
	}
	return ports
}
