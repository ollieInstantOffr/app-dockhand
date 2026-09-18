package hosts

import (
	"bufio"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dockhand/internal/util"
)

// ProbeScript prints the facts the poller needs in one round trip. diskPath is
// the directory whose filesystem usage is reported (Docker's root dir, or /).
func ProbeScript(diskPath string) string {
	if diskPath == "" {
		diskPath = "/"
	}
	return `export LC_ALL=C
echo '@@stat'; head -n1 /proc/stat
echo '@@mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo '@@df'; (df -P -k ` + util.Shq(diskPath) + ` 2>/dev/null || df -P -k /) | tail -n1
echo '@@uptime'; cat /proc/uptime
echo '@@os'; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
echo '@@kernel'; uname -r
echo '@@nproc'; (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
echo '@@end'
`
}

// CPUSample is the aggregate "cpu" line of /proc/stat.
type CPUSample struct {
	Total uint64
	Idle  uint64 // idle + iowait
}

// Probe is the parsed output of ProbeScript.
type Probe struct {
	CPU       CPUSample
	MemTotal  int64
	MemUsed   int64
	DiskTotal int64
	DiskUsed  int64
	UptimeSec int64
	OS        string
	Kernel    string
	Cores     int
}

// ParseProbe parses ProbeScript output.
func ParseProbe(out string) (Probe, error) {
	var p Probe
	sections := map[string][]string{}
	cur := ""
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.HasPrefix(line, "@@") {
			cur = strings.TrimPrefix(line, "@@")
			continue
		}
		if cur != "" && strings.TrimSpace(line) != "" {
			sections[cur] = append(sections[cur], line)
		}
	}
	if _, ok := sections["stat"]; !ok {
		return p, errors.New("unexpected probe output (is this a Linux host?)")
	}
	var err error
	if p.CPU, err = ParseCPULine(first(sections["stat"])); err != nil {
		return p, err
	}
	var memAvail int64 = -1
	for _, l := range sections["mem"] {
		f := strings.Fields(l)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseInt(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			p.MemTotal = v * 1024
		case "MemAvailable:":
			memAvail = v * 1024
		}
	}
	if memAvail >= 0 && p.MemTotal > 0 {
		p.MemUsed = p.MemTotal - memAvail
	}
	if f := strings.Fields(first(sections["df"])); len(f) >= 4 {
		total, _ := strconv.ParseInt(f[1], 10, 64)
		used, _ := strconv.ParseInt(f[2], 10, 64)
		avail, _ := strconv.ParseInt(f[3], 10, 64)
		p.DiskTotal = total * 1024
		// Report used relative to what's usable (like df's Use%).
		if used+avail > 0 {
			p.DiskTotal = (used + avail) * 1024
		}
		p.DiskUsed = used * 1024
	}
	if f := strings.Fields(first(sections["uptime"])); len(f) >= 1 {
		up, _ := strconv.ParseFloat(f[0], 64)
		p.UptimeSec = int64(up)
	}
	p.OS = strings.TrimSpace(first(sections["os"]))
	p.Kernel = strings.TrimSpace(first(sections["kernel"]))
	p.Cores, _ = strconv.Atoi(strings.TrimSpace(first(sections["nproc"])))
	return p, nil
}

func first(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

// ParseCPULine parses the "cpu  user nice system idle iowait irq softirq steal …" line.
func ParseCPULine(line string) (CPUSample, error) {
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return CPUSample{}, fmt.Errorf("unexpected /proc/stat line %q", line)
	}
	var s CPUSample
	for i, v := range f[1:] {
		// guest and guest_nice (fields 9, 10) are already included in user/nice.
		if i >= 8 {
			break
		}
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return CPUSample{}, fmt.Errorf("bad /proc/stat value %q", v)
		}
		s.Total += n
		if i == 3 || i == 4 { // idle, iowait
			s.Idle += n
		}
	}
	return s, nil
}

// CPUPercent computes utilisation between two samples (0–100). It returns -1
// when there's no usable previous sample.
func CPUPercent(prev, cur CPUSample) float64 {
	if prev.Total == 0 || cur.Total <= prev.Total || cur.Idle < prev.Idle {
		return -1
	}
	dt := float64(cur.Total - prev.Total)
	di := float64(cur.Idle - prev.Idle)
	pct := (dt - di) / dt * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return float64(int64(pct*10+0.5)) / 10
}
