package github

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// EnvVar is one entry of a .env.example file.
type EnvVar struct {
	Key      string
	Value    string
	Comment  string
	Required bool
}

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.\-]*$`)

// ParseEnvExample parses a .env.example file. Comment lines directly above a
// variable (not separated by a blank line) and inline comments become
// Comment. Required is set when the value is empty or looks like a
// placeholder. Duplicate keys keep their first position and last value.
func ParseEnvExample(b []byte) []EnvVar {
	var out []EnvVar
	index := map[string]int{}
	var pending []string
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	text = strings.TrimPrefix(text, "\ufeff")
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			pending = nil
			continue
		}
		if strings.HasPrefix(line, "#") {
			c := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if c != "" && !isDecorative(c) {
				pending = append(pending, c)
			}
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, rest, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !envKeyRe.MatchString(key) {
			pending = nil
			continue
		}
		value, inline := parseEnvValue(strings.TrimSpace(rest))
		comments := append([]string{}, pending...)
		if inline != "" {
			comments = append(comments, inline)
		}
		v := EnvVar{
			Key:      key,
			Value:    value,
			Comment:  strings.Join(comments, " "),
			Required: isPlaceholder(value),
		}
		if i, dup := index[key]; dup {
			out[i] = v
		} else {
			index[key] = len(out)
			out = append(out, v)
		}
		pending = nil
	}
	return out
}

// isDecorative reports comment lines made only of separator characters.
func isDecorative(s string) bool {
	return strings.Trim(s, "-=*#~_ ") == ""
}

// parseEnvValue returns the value and any inline comment.
func parseEnvValue(s string) (value, comment string) {
	if s == "" {
		return "", ""
	}
	switch q := s[0]; q {
	case '"', '\'', '`':
		var sb strings.Builder
		i := 1
		closed := false
		for ; i < len(s); i++ {
			ch := s[i]
			if q == '"' && ch == '\\' && i+1 < len(s) {
				i++
				switch s[i] {
				case 'n':
					sb.WriteByte('\n')
				case 't':
					sb.WriteByte('\t')
				default:
					sb.WriteByte(s[i])
				}
				continue
			}
			if ch == q {
				closed = true
				break
			}
			sb.WriteByte(ch)
		}
		if !closed {
			// Unterminated quote: treat literally.
			return strings.TrimSpace(s), ""
		}
		rest := strings.TrimSpace(s[i+1:])
		if strings.HasPrefix(rest, "#") {
			comment = strings.TrimSpace(strings.TrimLeft(rest, "#"))
		}
		return sb.String(), comment
	}
	if strings.HasPrefix(s, "#") {
		return "", strings.TrimSpace(strings.TrimLeft(s, "#"))
	}
	for i := 1; i < len(s); i++ {
		if s[i] == '#' && (s[i-1] == ' ' || s[i-1] == '\t') {
			return strings.TrimSpace(s[:i]), strings.TrimSpace(strings.TrimLeft(s[i:], "#"))
		}
	}
	return s, ""
}

var placeholderRe = regexp.MustCompile(`(?i)^(` +
	`change[-_ .]?me.*|.*changeme.*|replace[-_ .]?me.*|todo|tbd|fixme|` +
	`x{3,}|\*{3,}|\.{3}|\x{2026}|` +
	`your[-_ .].*|` +
	`<.*>|\{\{.*\}\}|` +
	`(set|insert|put|enter|add)[-_ ](your|a|the)[-_ ].*|` +
	`secret|password|token|api[-_]?key` +
	`)$`)

func isPlaceholder(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	return placeholderRe.MatchString(v)
}

// ComposeService summarises one service of a Compose file.
type ComposeService struct {
	Name  string
	Image string // image, or "build: <context>"
	Meta  string // e.g. "8000/tcp · 2 vols"
}

// ParseComposeServices returns the services of a Compose file in file order.
// Invalid YAML yields nil.
func ParseComposeServices(b []byte) []ComposeService {
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil || len(doc.Content) == 0 {
		return nil
	}
	root := doc.Content[0]
	services := mapValue(root, "services")
	if services == nil || services.Kind != yaml.MappingNode {
		return nil
	}
	out := []ComposeService{}
	for i := 0; i+1 < len(services.Content); i += 2 {
		name := services.Content[i].Value
		node := services.Content[i+1]
		var svc struct {
			Image   string      `yaml:"image"`
			Build   yaml.Node   `yaml:"build"`
			Ports   []yaml.Node `yaml:"ports"`
			Expose  []yaml.Node `yaml:"expose"`
			Volumes []yaml.Node `yaml:"volumes"`
		}
		_ = node.Decode(&svc) // best effort: keep whatever decoded
		cs := ComposeService{Name: name, Image: svc.Image}
		if cs.Image == "" {
			cs.Image = "build: " + buildContext(&svc.Build)
		}
		var ports []string
		seen := map[string]bool{}
		for _, p := range svc.Ports {
			if s := portString(&p, true); s != "" && !seen[s] {
				seen[s] = true
				ports = append(ports, s)
			}
		}
		for _, p := range svc.Expose {
			if s := portString(&p, false); s != "" && !seen[s] {
				seen[s] = true
				ports = append(ports, s)
			}
		}
		var meta []string
		if len(ports) > 0 {
			meta = append(meta, strings.Join(ports, ", "))
		}
		switch n := len(svc.Volumes); {
		case n == 1:
			meta = append(meta, "1 vol")
		case n > 1:
			meta = append(meta, fmt.Sprintf("%d vols", n))
		}
		cs.Meta = strings.Join(meta, " · ")
		out = append(out, cs)
	}
	return out
}

func mapValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func buildContext(n *yaml.Node) string {
	switch n.Kind {
	case yaml.ScalarNode:
		if n.Value != "" {
			return n.Value
		}
	case yaml.MappingNode:
		if c := mapValue(n, "context"); c != nil && c.Value != "" {
			return c.Value
		}
	}
	return "."
}

// portString renders a ports/expose entry as "<port>/<proto>", preferring the
// published (host) port when one is given.
func portString(n *yaml.Node, published bool) string {
	switch n.Kind {
	case yaml.MappingNode: // long syntax
		proto := "tcp"
		if p := mapValue(n, "protocol"); p != nil && p.Value != "" {
			proto = p.Value
		}
		port := ""
		if published {
			if p := mapValue(n, "published"); p != nil {
				port = p.Value
			}
		}
		if port == "" {
			if t := mapValue(n, "target"); t != nil {
				port = t.Value
			}
		}
		if port == "" {
			return ""
		}
		return port + "/" + proto
	case yaml.ScalarNode:
		s := strings.TrimSpace(n.Value)
		if s == "" {
			return ""
		}
		proto := "tcp"
		if i := strings.LastIndex(s, "/"); i >= 0 && !strings.Contains(s[i:], "}") {
			proto, s = s[i+1:], s[:i]
		}
		parts := splitOutsideBraces(s, ':')
		port := parts[len(parts)-1]
		if published && len(parts) >= 2 && parts[len(parts)-2] != "" {
			port = parts[len(parts)-2]
		}
		if port == "" {
			return ""
		}
		if _, err := strconv.Atoi(port); err != nil && !strings.Contains(port, "-") && !strings.Contains(port, "$") {
			return ""
		}
		return port + "/" + proto
	}
	return ""
}

// splitOutsideBraces splits s on sep, ignoring separators inside ${...}.
func splitOutsideBraces(s string, sep byte) []string {
	var parts []string
	depth, start := 0, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			if depth > 0 {
				depth--
			}
		case sep:
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	return append(parts, s[start:])
}
