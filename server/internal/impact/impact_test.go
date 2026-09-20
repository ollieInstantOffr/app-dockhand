package impact

import (
	"testing"

	"dockhand/internal/hosts"
	"dockhand/internal/model"
	"dockhand/internal/uptime"
)

func TestMonitorTarget(t *testing.T) {
	cases := map[string]struct {
		host string
		port int
	}{
		"https://app.example.com/health": {"app.example.com", 443},
		"http://10.0.0.5:8080":           {"10.0.0.5", 8080},
		"10.0.0.5:5432":                  {"10.0.0.5", 5432},
		"lab-host-01":                    {"lab-host-01", 0},
	}
	for target, want := range cases {
		h, p := monitorTarget(uptime.Monitor{Target: target})
		if h != want.host || p != want.port {
			t.Errorf("%s → (%q, %d), want (%q, %d)", target, h, p, want.host, want.port)
		}
	}
}

func TestWatches(t *testing.T) {
	id := "host-1"
	rec := hosts.Record{}
	rec.ID = id
	rec.Name = "lab-host-01"
	rec.Address = "10.0.0.5"
	hostMon := uptime.Monitor{Type: "host", HostID: &id, Target: "10.0.0.5", Enabled: true}
	svcMon := uptime.Monitor{Type: "http", HostID: &id, Target: "http://10.0.0.5:8080/", Enabled: true}
	other := uptime.Monitor{Type: "http", Target: "https://elsewhere.example.com", Enabled: true}

	// A host-wide action (ports == nil) takes every monitor of that host.
	if !watches(hostMon, rec, nil) || !watches(svcMon, rec, nil) {
		t.Error("host action should match the host's monitors")
	}
	if watches(other, rec, nil) {
		t.Error("a monitor pointing elsewhere should not match")
	}
	// Stopping one container only matches monitors on its published ports.
	ports := map[int]bool{8080: true}
	if !watches(svcMon, rec, ports) {
		t.Error("service monitor on 8080 should match")
	}
	if watches(hostMon, rec, ports) {
		t.Error("the host's own monitor should survive one container stopping")
	}
	if watches(svcMon, rec, map[int]bool{9999: true}) {
		t.Error("monitor on a different port should not match")
	}
}

func TestSummarize(t *testing.T) {
	empty := model.Impact{Name: "lab-host-01"}
	if got := summarize(empty, "reboot"); got != "Rebooting lab-host-01 stops nothing that is running." {
		t.Errorf("empty summary: %q", got)
	}
	full := model.Impact{
		Name:     "web",
		Stops:    []model.ImpactItem{{Name: "a"}, {Name: "b"}},
		Stacks:   []model.ImpactItem{{Name: "web"}},
		Ports:    []model.ImpactItem{{Name: "10.0.0.5:443"}},
		Monitors: []model.ImpactItem{{Name: "site"}},
	}
	want := "Taking down web: 2 containers stop, 1 stack, 1 published port, 1 uptime check will fail."
	if got := summarize(full, "down"); got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
}
