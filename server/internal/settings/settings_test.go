package settings

import "testing"

func TestDeepMerge(t *testing.T) {
	base := map[string]any{"a": 1.0, "tools": map[string]any{"x": map[string]any{"enabled": true, "confirm": true}}}
	out := deepMerge(base, map[string]any{"b": 2.0, "tools": map[string]any{"x": map[string]any{"enabled": false}, "y": map[string]any{"enabled": true}}})
	tools := out["tools"].(map[string]any)
	x := tools["x"].(map[string]any)
	if out["a"] != 1.0 || out["b"] != 2.0 || x["enabled"] != false || x["confirm"] != true || tools["y"] == nil {
		t.Errorf("merged = %v", out)
	}
	if base["b"] != nil {
		t.Error("base mutated")
	}
}

func TestDefaultsValidate(t *testing.T) {
	d := Defaults("http://localhost:3000", []ToolInfo{{Name: "list_hosts"}, {Name: "reboot_host", Writes: true}})
	if err := validate(&d); err != nil {
		t.Fatal(err)
	}
	if d.MCP.Tools["reboot_host"].Confirm != true || d.MCP.Tools["list_hosts"].Confirm || !d.MCP.Tools["list_hosts"].Enabled {
		t.Errorf("tool prefs = %+v", d.MCP.Tools)
	}
	d.Uptime.IntervalSec = 45
	if validate(&d) == nil {
		t.Error("interval 45 should be rejected")
	}
}
