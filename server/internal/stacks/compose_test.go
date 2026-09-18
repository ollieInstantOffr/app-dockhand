package stacks

import "testing"

func TestValidateOK(t *testing.T) {
	v := Validate(`services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
      - target: 443
        published: 8443
        protocol: udp
  app:
    build: .
`)
	if !v.OK {
		t.Fatalf("unexpected error: %s (line %d)", v.Error, v.Line)
	}
	if len(v.Services) != 2 || v.Services[0].Name != "web" || v.Services[0].Image != "nginx:1.27" {
		t.Fatalf("services = %+v", v.Services)
	}
	if got := v.Services[0].Ports; len(got) != 2 || got[0] != "8080:80" || got[1] != "8443:443/udp" {
		t.Errorf("ports = %v", got)
	}
	if v.Services[1].Image != "(build)" {
		t.Errorf("build service image = %q", v.Services[1].Image)
	}
}

func TestValidateErrors(t *testing.T) {
	cases := []struct {
		name, content string
		line          int
	}{
		{"empty", "", 0},
		{"yaml syntax", "services:\n  web:\n    image: nginx\n  ports: x: y\n", 4},
		{"tab indent", "services:\n\tweb: 1\n", 2},
		{"no services", "volumes:\n  data:\n", 1},
		{"service without image", "services:\n  web:\n    ports: [\"80:80\"]\n", 2},
		{"ports not list", "services:\n  web:\n    image: x\n    ports: \"80:80\"\n", 4},
		{"unknown top-level", "services:\n  web:\n    image: x\nservice:\n  a: 1\n", 4},
		{"top-level list", "- a\n- b\n", 1},
	}
	for _, c := range cases {
		v := Validate(c.content)
		if v.OK {
			t.Errorf("%s: expected failure", c.name)
			continue
		}
		if c.line > 0 && v.Line != c.line {
			t.Errorf("%s: line = %d, want %d (%s)", c.name, v.Line, c.line, v.Error)
		}
	}
}

func TestTemplatesValid(t *testing.T) {
	for _, tpl := range Templates {
		if v := Validate(tpl.Content); !v.OK {
			t.Errorf("template %s invalid: %s (line %d)", tpl.ID, v.Error, v.Line)
		}
	}
}

func TestValidName(t *testing.T) {
	for _, n := range []string{"web", "my-app_2", "a"} {
		if ValidName(n) != nil {
			t.Errorf("%q should be valid", n)
		}
	}
	for _, n := range []string{"", "Web", "-x", "a b", "../x"} {
		if ValidName(n) == nil {
			t.Errorf("%q should be invalid", n)
		}
	}
}

func TestComposeCmd(t *testing.T) {
	r := Row{Name: "app", Path: "/opt/stacks/app", ComposeFile: "docker-compose.yml"}
	want := "cd '/opt/stacks/app' && docker compose -p 'app' -f '/opt/stacks/app/docker-compose.yml' up -d"
	if got := ComposeCmd(r, "up -d"); got != want {
		t.Errorf("ComposeCmd = %q", got)
	}
}
