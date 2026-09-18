package monitor

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"

	"dockhand/internal/model"
)

var exitRe = regexp.MustCompile(`^Exited \((-?\d+)\)`)

// HealthFromStatus derives the health from docker's human status string.
func HealthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}
	return "none"
}

// ExitCodeFromStatus parses "Exited (137) 3 hours ago".
func ExitCodeFromStatus(status string) int {
	if m := exitRe.FindStringSubmatch(status); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

// ContainerName strips the leading slash of a Docker name.
func ContainerName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return strings.TrimPrefix(names[0], "/")
}

// ImageTag returns the tag of an image reference ("latest" when absent).
func ImageTag(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	slash := strings.LastIndex(ref, "/")
	if i := strings.LastIndex(ref, ":"); i > slash {
		return ref[i+1:]
	}
	return "latest"
}

// Ports converts Docker port bindings, dropping IPv6 duplicates of IPv4 bindings.
func Ports(ps []container.Port) []model.PortMap {
	out := []model.PortMap{}
	seen := map[string]bool{}
	for _, p := range ps {
		key := strconv.Itoa(int(p.PrivatePort)) + "/" + p.Type + ":" + strconv.Itoa(int(p.PublicPort))
		if seen[key] {
			continue
		}
		seen[key] = true
		ip := p.IP
		if ip == "::" {
			ip = "0.0.0.0"
		}
		proto := p.Type
		if proto != "udp" {
			proto = "tcp"
		}
		out = append(out, model.PortMap{IP: ip, Host: int(p.PublicPort), Container: int(p.PrivatePort), Proto: proto})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Container != out[j].Container {
			return out[i].Container < out[j].Container
		}
		return out[i].Host < out[j].Host
	})
	return out
}

// FromSummary converts a container list entry.
func FromSummary(hostID string, c container.Summary) model.Container {
	id := c.ID
	short := id
	if len(short) > 12 {
		short = short[:12]
	}
	labels := c.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	mc := model.Container{
		ID: id, ShortID: short, HostID: hostID, Name: ContainerName(c.Names), Image: c.Image, ImageID: c.ImageID,
		State: string(c.State), Status: c.Status, Health: HealthFromStatus(c.Status), ExitCode: ExitCodeFromStatus(c.Status),
		Stack: labels["com.docker.compose.project"], Service: labels["com.docker.compose.service"],
		Ports: Ports(c.Ports), CreatedAt: time.Unix(c.Created, 0).UTC(),
		Update: model.UpdateInfo{Tag: ImageTag(c.Image)}, Labels: labels,
		WorkingDir: labels["com.docker.compose.project.working_dir"],
	}
	if mc.State == "" {
		mc.State = "created"
	}
	return mc
}

// ParseDockerTime parses Docker's RFC3339Nano timestamps; zero values yield nil.
func ParseDockerTime(s string) *time.Time {
	if s == "" || strings.HasPrefix(s, "0001-") {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	return &t
}

// ring is a fixed-capacity sample buffer.
type ring struct {
	vals []float64
	cap  int
}

func newRing(n int) *ring { return &ring{cap: n} }

func (r *ring) push(v float64) {
	r.vals = append(r.vals, v)
	if len(r.vals) > r.cap {
		r.vals = r.vals[len(r.vals)-r.cap:]
	}
}

func (r *ring) snapshot() []float64 {
	return append([]float64{}, r.vals...)
}

func (r *ring) last() float64 {
	if len(r.vals) == 0 {
		return 0
	}
	return r.vals[len(r.vals)-1]
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
