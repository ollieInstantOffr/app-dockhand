package dockerops

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/volume"

	"dockhand/internal/model"
)

func TestSummarizeDisk(t *testing.T) {
	du := types.DiskUsage{
		LayersSize: 900,
		Images: []*image.Summary{
			{Size: 500, SharedSize: 200, Containers: 1},
			{Size: 400, SharedSize: 200, Containers: 0}, // unique 200 reclaimable
			{Size: 100, SharedSize: -1, Containers: 0},  // unknown shared → whole size
		},
		Containers: []*container.Summary{{SizeRw: 10, State: "running"}, {SizeRw: 30, State: "exited"}},
		Volumes: []*volume.Volume{
			{UsageData: &volume.UsageData{Size: 1000, RefCount: 1}},
			{UsageData: &volume.UsageData{Size: 50, RefCount: 0}},
			{UsageData: &volume.UsageData{Size: -1, RefCount: 0}},
			{},
		},
		BuildCache: []*build.CacheRecord{{Size: 70, InUse: true}, {Size: 30}, {Size: 999, Shared: true}},
	}
	got := SummarizeDisk(du)
	want := map[string]model.DiskCategory{
		"images":     {Size: 900, Reclaimable: 300, Count: 3, Active: 1},
		"containers": {Size: 40, Reclaimable: 30, Count: 2, Active: 1},
		"volumes":    {Size: 1050, Reclaimable: 50, Count: 4, Active: 1},
		"buildCache": {Size: 1099, Reclaimable: 30, Count: 3, Active: 1},
	}
	if len(got.Categories) != 4 {
		t.Fatalf("categories: %+v", got.Categories)
	}
	for _, c := range got.Categories {
		w := want[c.Key]
		if c.Size != w.Size || c.Reclaimable != w.Reclaimable || c.Count != w.Count || c.Active != w.Active || c.Label == "" {
			t.Errorf("%s: got %+v want %+v", c.Key, c, w)
		}
	}
	if got.Used != 900+40+1050+1099 || got.Reclaimable != 300+30+50+30 {
		t.Errorf("totals: used %d reclaimable %d", got.Used, got.Reclaimable)
	}
	// Empty input still yields four categories and serialises arrays, not null.
	b, _ := json.Marshal(SummarizeDisk(types.DiskUsage{}))
	if !strings.Contains(string(b), `"categories":[{`) {
		t.Errorf("json: %s", b)
	}
}

func TestParseDfSize(t *testing.T) {
	cases := map[string]int64{
		" 62725623808\n@@\n/dev/sda1 61255492 1 2 3% /\n":          62725623808,
		"@@\n/dev/sda1 61255492 30000000 31255492 49% /\n":         61255492 * 1024,
		"   Size\n 62725623808\n@@\n/dev/sda1 61255492 1 2 3% /\n": 61255492 * 1024, // unexpected GNU shape → POSIX
		"df: unrecognized option\n@@\n":                            0,
		"":                                                         0,
	}
	for in, want := range cases {
		if got := ParseDfSize(in); got != want {
			t.Errorf("ParseDfSize(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestBuildRunSpecAndCommand(t *testing.T) {
	in := model.RunContainerInput{HostID: "h", Image: " nginx:1.27 ", Name: "web", Restart: "unless-stopped", Network: "proxy", Traefik: true,
		Env: []model.KV{{K: "TZ", V: "Europe/Oslo"}, {K: "MSG", V: "hello world"}, {K: " ", V: "x"}}}
	in.Ports = append(in.Ports, struct {
		Host      string `json:"host"`
		Container string `json:"container"`
	}{"127.0.0.1:8080", "80"}, struct {
		Host      string `json:"host"`
		Container string `json:"container"`
	}{"", "53/udp"})
	in.Volumes = append(in.Volumes, struct {
		Src string `json:"src"`
		Dst string `json:"dst"`
	}{"data", "/usr/share/nginx/html"})
	spec, err := BuildRunSpec(in, "example.com")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Config.Image != "nginx:1.27" || spec.HostConfig.RestartPolicy.Name != "unless-stopped" || len(spec.Config.Env) != 2 {
		t.Fatalf("spec: %+v %+v", spec.Config, spec.HostConfig)
	}
	cmd := DockerRunCommand(spec)
	want := "docker run -d --name web --restart unless-stopped --network proxy --expose 53/udp -p 127.0.0.1:8080:80 " +
		"-v data:/usr/share/nginx/html -e TZ=Europe/Oslo -e 'MSG=hello world' --label dockhand.managed=true --label traefik.enable=true " +
		"--label 'traefik.http.routers.web.rule=Host(`web.example.com`)' nginx:1.27"
	if cmd != want {
		t.Errorf("command:\n got %s\nwant %s", cmd, want)
	}
	if _, err := BuildRunSpec(model.RunContainerInput{Image: "x", Restart: "sometimes"}, ""); err == nil {
		t.Error("bad restart accepted")
	}
	if _, err := BuildRunSpec(model.RunContainerInput{Image: "x", Name: "-x"}, ""); err == nil {
		t.Error("bad name accepted")
	}
}
