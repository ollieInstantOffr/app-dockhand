package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeProvider struct {
	enabled  bool
	lastCall CallContext
}

func (f *fakeProvider) Enabled() bool { return f.enabled }

func (f *fakeProvider) Authenticate(r *http.Request) (string, string, bool) {
	if r.Header.Get("Authorization") == "Bearer dh_good" {
		return "k1", "Claude Desktop", true
	}
	return "", "", false
}

func (f *fakeProvider) Tools(keyID string) []Tool {
	var out []Tool
	for _, t := range Catalog() {
		if t.Name == "list_hosts" || t.Name == "restart_container" || t.Name == "get_logs" {
			out = append(out, t)
		}
	}
	return out
}

func (f *fakeProvider) Call(ctx context.Context, c CallContext, name string) (Result, error) {
	f.lastCall = c
	switch name {
	case "list_hosts":
		return Result{Text: "web-1 (online)"}, nil
	case "restart_container":
		if c.Args["confirm"] != true {
			return Result{Text: "Would restart nginx on web-1. Call again with confirm=true.", IsError: true}, nil
		}
		return Result{Text: "restarted"}, nil
	}
	return Result{}, errors.New("docker daemon unreachable")
}

func do(t *testing.T, srv *httptest.Server, method, auth, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func TestHandler(t *testing.T) {
	fp := &fakeProvider{enabled: true}
	srv := httptest.NewServer(NewHandler(fp, "dockhand", "1.2.3"))
	defer srv.Close()
	const auth = "Bearer dh_good"

	tests := []struct {
		name       string
		method     string
		auth       string
		body       string
		wantStatus int
		check      func(t *testing.T, resp *http.Response, body []byte)
	}{
		{
			name: "initialize echoes supported version", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if resp.Header.Get("Mcp-Session-Id") == "" {
					t.Error("missing Mcp-Session-Id")
				}
				if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
					t.Errorf("content-type %q", ct)
				}
				var r response
				mustJSON(t, body, &r)
				var res struct {
					ProtocolVersion string `json:"protocolVersion"`
					Capabilities    struct {
						Tools struct {
							ListChanged *bool `json:"listChanged"`
						} `json:"tools"`
					} `json:"capabilities"`
					ServerInfo   struct{ Name, Version string } `json:"serverInfo"`
					Instructions string                         `json:"instructions"`
				}
				mustJSON(t, r.Result, &res)
				if string(r.ID) != "1" || res.ProtocolVersion != "2025-03-26" || res.ServerInfo.Name != "dockhand" ||
					res.ServerInfo.Version != "1.2.3" || res.Capabilities.Tools.ListChanged == nil || *res.Capabilities.Tools.ListChanged ||
					!strings.Contains(res.Instructions, "Dockhand") {
					t.Errorf("unexpected initialize result %s", body)
				}
			},
		},
		{
			name: "initialize with unknown version falls back", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"1999-01-01"}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if !strings.Contains(string(body), `"protocolVersion":"2025-06-18"`) || !strings.Contains(string(body), `"id":"a"`) {
					t.Errorf("body %s", body)
				}
			},
		},
		{
			name: "initialized notification", method: "POST", auth: auth, wantStatus: 202,
			body: `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if len(body) != 0 {
					t.Errorf("expected empty body, got %s", body)
				}
			},
		},
		{
			name: "ping", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":7,"method":"ping"}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				if string(r.Result) != "{}" || r.Error != nil {
					t.Errorf("body %s", body)
				}
			},
		},
		{
			name: "tools/list", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				var res struct {
					Tools []struct {
						Name        string         `json:"name"`
						Description string         `json:"description"`
						InputSchema map[string]any `json:"inputSchema"`
						Annotations struct {
							Title           string `json:"title"`
							ReadOnlyHint    bool   `json:"readOnlyHint"`
							DestructiveHint bool   `json:"destructiveHint"`
						} `json:"annotations"`
					} `json:"tools"`
				}
				mustJSON(t, r.Result, &res)
				if len(res.Tools) != 3 {
					t.Fatalf("want 3 tools, got %d", len(res.Tools))
				}
				for _, tl := range res.Tools {
					write := tl.Name == "restart_container"
					if tl.Annotations.ReadOnlyHint == write || tl.Annotations.DestructiveHint != write || tl.Description == "" ||
						tl.InputSchema["type"] != "object" || tl.Annotations.Title == "" {
						t.Errorf("bad tool %+v", tl)
					}
				}
			},
		},
		{
			name: "tools/call success", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_hosts","arguments":{}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				want := `{"content":[{"text":"web-1 (online)","type":"text"}],"isError":false}`
				if string(r.Result) != want {
					t.Errorf("got %s want %s", r.Result, want)
				}
				if fp.lastCall.KeyID != "k1" || fp.lastCall.KeyName != "Claude Desktop" {
					t.Errorf("call context %+v", fp.lastCall)
				}
			},
		},
		{
			name: "tools/call isError", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"restart_container","arguments":{"host":"web-1","container":"nginx"}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				if r.Error != nil || !strings.Contains(string(r.Result), `"isError":true`) || !strings.Contains(string(r.Result), "confirm=true") {
					t.Errorf("body %s", body)
				}
			},
		},
		{
			name: "tools/call with confirm and numbers", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"restart_container","arguments":{"host":"web-1","container":"nginx","confirm":true,"n":3}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if !strings.Contains(string(body), `"text":"restarted"`) {
					t.Errorf("body %s", body)
				}
				if v, ok := fp.lastCall.Args["n"].(int64); !ok || v != 3 {
					t.Errorf("number arg = %#v", fp.lastCall.Args["n"])
				}
			},
		},
		{
			name: "tools/call Go error is JSON-RPC error", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_logs","arguments":{"host":"h","container":"c"}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				if r.Error == nil || r.Error.Code != -32603 || !strings.Contains(r.Error.Message, "unreachable") {
					t.Errorf("body %s", body)
				}
			},
		},
		{
			name: "unknown tool is isError", method: "POST", auth: auth, wantStatus: 200,
			body: `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"reboot_host","arguments":{}}}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var r response
				mustJSON(t, body, &r)
				if r.Error != nil || !strings.Contains(string(r.Result), `"isError":true`) {
					t.Errorf("body %s", body)
				}
			},
		},
		{
			name: "unknown method", method: "POST", auth: auth, wantStatus: 200,
			body:  `{"jsonrpc":"2.0","id":9,"method":"resources/list"}`,
			check: wantErrCode(-32601),
		},
		{
			name: "parse error", method: "POST", auth: auth, wantStatus: 200,
			body:  `{"jsonrpc":"2.0",`,
			check: wantErrCode(-32700),
		},
		{
			name: "invalid request", method: "POST", auth: auth, wantStatus: 200,
			body:  `{"jsonrpc":"1.0","id":1,"method":"ping"}`,
			check: wantErrCode(-32600),
		},
		{
			name: "invalid request not object", method: "POST", auth: auth, wantStatus: 200,
			body:  `42`,
			check: wantErrCode(-32600),
		},
		{
			name: "batch", method: "POST", auth: auth, wantStatus: 200,
			body: `[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_hosts"}},{"jsonrpc":"2.0","id":3,"method":"nope"}]`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				var rs []response
				mustJSON(t, body, &rs)
				if len(rs) != 3 || string(rs[0].ID) != "1" || string(rs[1].ID) != "2" || rs[2].Error == nil || rs[2].Error.Code != -32601 {
					t.Errorf("batch body %s", body)
				}
			},
		},
		{
			name: "batch of notifications", method: "POST", auth: auth, wantStatus: 202,
			body: `[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}]`,
		},
		{
			name: "empty batch", method: "POST", auth: auth, wantStatus: 200,
			body:  `[]`,
			check: wantErrCode(-32600),
		},
		{
			name: "client response is accepted", method: "POST", auth: auth, wantStatus: 202,
			body: `{"jsonrpc":"2.0","id":99,"result":{}}`,
		},
		{
			name: "missing auth", method: "POST", auth: "", wantStatus: 401,
			body: `{"jsonrpc":"2.0","id":1,"method":"ping"}`,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), "Bearer") {
					t.Errorf("WWW-Authenticate = %q", resp.Header.Get("WWW-Authenticate"))
				}
				if strings.Contains(string(body), "jsonrpc") {
					t.Errorf("401 body should not be JSON-RPC: %s", body)
				}
			},
		},
		{
			name: "wrong auth", method: "POST", auth: "Bearer dh_bad", wantStatus: 401,
			body: `{"jsonrpc":"2.0","id":1,"method":"ping"}`,
		},
		{
			name: "GET not allowed", method: "GET", auth: auth, wantStatus: 405,
			check: func(t *testing.T, resp *http.Response, body []byte) {
				if resp.Header.Get("Allow") != "POST" {
					t.Errorf("Allow = %q", resp.Header.Get("Allow"))
				}
			},
		},
		{
			name: "DELETE ends session", method: "DELETE", auth: auth, wantStatus: 200,
		},
		{
			name: "body too large", method: "POST", auth: auth, wantStatus: 413,
			body: `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"` + strings.Repeat("a", 1<<20) + `"}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, body := do(t, srv, tt.method, tt.auth, tt.body)
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", resp.StatusCode, tt.wantStatus, body)
			}
			if tt.check != nil {
				tt.check(t, resp, body)
			}
		})
	}
}

func TestHandlerDisabled(t *testing.T) {
	srv := httptest.NewServer(NewHandler(&fakeProvider{enabled: false}, "dockhand", "dev"))
	defer srv.Close()
	for _, m := range []string{"POST", "GET"} {
		resp, _ := do(t, srv, m, "Bearer dh_good", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
		if resp.StatusCode != 404 {
			t.Fatalf("%s: status = %d, want 404", m, resp.StatusCode)
		}
	}
}

func TestCatalog(t *testing.T) {
	want := map[string]struct {
		group  string
		writes bool
	}{
		"list_hosts": {"Hosts", false}, "host_stats": {"Hosts", false}, "reboot_host": {"Hosts", true},
		"list_containers": {"Containers", false}, "inspect_container": {"Containers", false},
		"start_container": {"Containers", true}, "stop_container": {"Containers", true},
		"restart_container": {"Containers", true}, "remove_container": {"Containers", true},
		"update_container": {"Containers", true},
		"get_logs":         {"Logs", false}, "search_logs": {"Logs", false},
		"list_stacks": {"Stacks", false}, "get_compose": {"Stacks", false},
		"stack_action": {"Stacks", true}, "update_compose": {"Stacks", true},
		"list_images": {"Images", false}, "pull_image": {"Images", true}, "prune_images": {"Images", true},
		"deploy_from_github": {"Deploy", true}, "run_container": {"Deploy", true},
	}
	cat := Catalog()
	if len(cat) != 21 || len(want) != 21 {
		t.Fatalf("catalog has %d tools, want 21", len(cat))
	}
	seen := map[string]bool{}
	for _, tl := range cat {
		w, ok := want[tl.Name]
		if !ok {
			t.Errorf("unexpected tool %s", tl.Name)
			continue
		}
		if seen[tl.Name] {
			t.Errorf("duplicate tool %s", tl.Name)
		}
		seen[tl.Name] = true
		if tl.Group != w.group || tl.Writes != w.writes || tl.Description == "" {
			t.Errorf("%s: group=%s writes=%v", tl.Name, tl.Group, tl.Writes)
		}
		props, _ := tl.InputSchema["properties"].(map[string]any)
		if tl.InputSchema["type"] != "object" || props == nil {
			t.Errorf("%s: bad schema", tl.Name)
		}
		_, hasConfirm := props["confirm"]
		if hasConfirm != tl.Writes {
			t.Errorf("%s: confirm present=%v writes=%v", tl.Name, hasConfirm, tl.Writes)
		}
		if req, ok := tl.InputSchema["required"].([]string); ok {
			for _, r := range req {
				if _, ok := props[r]; !ok {
					t.Errorf("%s: required %q not in properties", tl.Name, r)
				}
				if r == "confirm" {
					t.Errorf("%s: confirm must be optional", tl.Name)
				}
			}
		}
		if _, err := json.Marshal(tl.InputSchema); err != nil {
			t.Errorf("%s: schema not serialisable: %v", tl.Name, err)
		}
	}
}

func wantErrCode(code int) func(t *testing.T, resp *http.Response, body []byte) {
	return func(t *testing.T, resp *http.Response, body []byte) {
		var r response
		mustJSON(t, body, &r)
		if r.Error == nil || r.Error.Code != code {
			t.Errorf("want error %d, body %s", code, body)
		}
	}
}

func mustJSON(t *testing.T, b []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("unmarshal %s: %v", b, err)
	}
}
