package hosts

import "testing"

const sampleProbe = `@@stat
cpu  4705 356 584 3699 23 23 0 0 0 0
@@mem
MemTotal:        8048000 kB
MemAvailable:    6036000 kB
@@df
/dev/sda1  102400000  40960000  61440000  40% /
@@uptime
3600.52 7000.10
@@os
Ubuntu 24.04.1 LTS
@@kernel
6.8.0-45-generic
@@nproc
4
@@end
`

func TestParseProbe(t *testing.T) {
	p, err := ParseProbe(sampleProbe)
	if err != nil {
		t.Fatal(err)
	}
	if p.CPU.Total != 4705+356+584+3699+23+23 || p.CPU.Idle != 3699+23 {
		t.Errorf("cpu sample = %+v", p.CPU)
	}
	if p.MemTotal != 8048000*1024 || p.MemUsed != (8048000-6036000)*1024 {
		t.Errorf("mem = %d/%d", p.MemUsed, p.MemTotal)
	}
	if p.DiskUsed != 40960000*1024 || p.DiskTotal != (40960000+61440000)*1024 {
		t.Errorf("disk = %d/%d", p.DiskUsed, p.DiskTotal)
	}
	if p.UptimeSec != 3600 || p.OS != "Ubuntu 24.04.1 LTS" || p.Kernel != "6.8.0-45-generic" || p.Cores != 4 {
		t.Errorf("facts = %+v", p)
	}
}

func TestParseProbeGarbage(t *testing.T) {
	if _, err := ParseProbe("sh: not found"); err == nil {
		t.Error("expected error")
	}
}

func TestCPUPercent(t *testing.T) {
	prev, _ := ParseCPULine("cpu  100 0 100 800 0 0 0 0 0 0")
	cur, _ := ParseCPULine("cpu  150 0 150 900 0 0 0 0 0 0")
	if got := CPUPercent(prev, cur); got != 50 {
		t.Errorf("CPUPercent = %v, want 50", got)
	}
	if got := CPUPercent(CPUSample{}, cur); got != -1 {
		t.Errorf("no previous sample = %v, want -1", got)
	}
	if got := CPUPercent(cur, prev); got != -1 {
		t.Errorf("counter reset = %v, want -1", got)
	}
	// iowait counts as idle
	a, _ := ParseCPULine("cpu 0 0 0 0 0")
	b, _ := ParseCPULine("cpu 25 0 0 50 25")
	if got := CPUPercent(CPUSample{Total: 1, Idle: 0}, b); got < 0 {
		t.Errorf("unexpected %v", got)
	}
	_ = a
	if _, err := ParseCPULine("cpu0 1 2 3 4"); err == nil {
		t.Error("expected error for per-core line")
	}
}
