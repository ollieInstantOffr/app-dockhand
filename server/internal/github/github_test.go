package github

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sign(secret, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

func TestVerifySignature(t *testing.T) {
	body := `{"ref":"refs/heads/main"}`
	good := sign("s3cret", body)
	tests := []struct {
		name   string
		secret string
		body   string
		header string
		want   bool
	}{
		{"valid", "s3cret", body, good, true},
		{"valid with whitespace", "s3cret", body, " " + good + " ", true},
		{"wrong secret", "other", body, good, false},
		{"tampered body", "s3cret", body + " ", good, false},
		{"missing prefix", "s3cret", body, strings.TrimPrefix(good, "sha256="), false},
		{"sha1 prefix", "s3cret", body, "sha1=" + strings.TrimPrefix(good, "sha256="), false},
		{"not hex", "s3cret", body, "sha256=zzzz", false},
		{"truncated", "s3cret", body, good[:len(good)-2], false},
		{"empty header", "s3cret", body, "", false},
		{"empty secret", "", body, sign("", body), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := VerifySignature([]byte(tt.secret), []byte(tt.body), tt.header); got != tt.want {
				t.Fatalf("VerifySignature = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAppJWT(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	ecKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("garbage")})
	now := time.Unix(1_700_000_000, 0)
	tests := []struct {
		name    string
		pem     []byte
		wantErr bool
	}{
		{"pkcs1", pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), false},
		{"pkcs8", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}), false},
		{"not pem", []byte("hello"), true},
		{"bad der", ecKeyPEM, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tok, err := AppJWT(12345, tt.pem, now)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			parts := strings.Split(tok, ".")
			if len(parts) != 3 {
				t.Fatalf("want 3 parts, got %d", len(parts))
			}
			enc := base64.RawURLEncoding
			var hdr map[string]string
			hb, _ := enc.DecodeString(parts[0])
			if err := json.Unmarshal(hb, &hdr); err != nil || hdr["alg"] != "RS256" {
				t.Fatalf("header = %s", hb)
			}
			var claims struct {
				Iat int64  `json:"iat"`
				Exp int64  `json:"exp"`
				Iss string `json:"iss"`
			}
			cb, _ := enc.DecodeString(parts[1])
			if err := json.Unmarshal(cb, &claims); err != nil {
				t.Fatal(err)
			}
			if claims.Iat != now.Unix()-60 || claims.Exp != now.Unix()+540 || claims.Iss != "12345" {
				t.Fatalf("claims = %+v", claims)
			}
			sig, err := enc.DecodeString(parts[2])
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
			if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
				t.Fatalf("signature does not verify: %v", err)
			}
		})
	}
}

func TestParseEnvExample(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []EnvVar
	}{
		{
			name: "basic and comments",
			in: "# Database connection\n# used by the api\nDATABASE_URL=postgres://db/app\n\n" +
				"# ----------\n\nPORT=8000 # http port\nEMPTY=\n",
			want: []EnvVar{
				{Key: "DATABASE_URL", Value: "postgres://db/app", Comment: "Database connection used by the api"},
				{Key: "PORT", Value: "8000", Comment: "http port"},
				{Key: "EMPTY", Required: true},
			},
		},
		{
			name: "quotes and export",
			in:   "export A=\"hello # not a comment\" # real\nB='single $x'\nC=\"line\\nbreak\"\nD=a#b\n",
			want: []EnvVar{
				{Key: "A", Value: "hello # not a comment", Comment: "real"},
				{Key: "B", Value: "single $x"},
				{Key: "C", Value: "line\nbreak"},
				{Key: "D", Value: "a#b"},
			},
		},
		{
			name: "placeholders",
			in: "S1=changeme\nS2=<your-token>\nS3=xxx\nS4=your-api-key\nS5=CHANGE_ME_PLEASE\nS6=replace-me\n" +
				"OK1=production\nOK2=yours\nOK3=\"\"\n",
			want: []EnvVar{
				{Key: "S1", Value: "changeme", Required: true},
				{Key: "S2", Value: "<your-token>", Required: true},
				{Key: "S3", Value: "xxx", Required: true},
				{Key: "S4", Value: "your-api-key", Required: true},
				{Key: "S5", Value: "CHANGE_ME_PLEASE", Required: true},
				{Key: "S6", Value: "replace-me", Required: true},
				{Key: "OK1", Value: "production"},
				{Key: "OK2", Value: "yours"},
				{Key: "OK3", Required: true},
			},
		},
		{
			name: "crlf, junk lines, duplicates",
			in:   "\ufeffA=1\r\nnot a var\r\n1BAD=2\r\nA=3\r\n",
			want: []EnvVar{{Key: "A", Value: "3"}},
		},
		{name: "empty", in: "", want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseEnvExample([]byte(tt.in))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got  %#v\nwant %#v", got, tt.want)
			}
		})
	}
}

func TestParseComposeServices(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []ComposeService
	}{
		{
			name: "order, build, ports, volumes",
			in: `
services:
  web:
    build: ./app
    ports: ["8000:8000"]
    volumes: [data:/data, ./conf:/conf]
  db:
    image: postgres:16
    volumes:
      - pg:/var/lib/postgresql/data
  cache:
    image: redis:7
    expose: ["6379"]
  proxy:
    image: traefik:v3
    ports:
      - "127.0.0.1:8080:80"
      - "443:443/udp"
      - target: 9000
        published: "9090"
        protocol: tcp
  worker:
    build:
      context: ./worker
      dockerfile: Dockerfile
  envport:
    image: app
    ports: ["${PORT:-3000}:3000"]
  bare:
    build: {}
`,
			want: []ComposeService{
				{Name: "web", Image: "build: ./app", Meta: "8000/tcp · 2 vols"},
				{Name: "db", Image: "postgres:16", Meta: "1 vol"},
				{Name: "cache", Image: "redis:7", Meta: "6379/tcp"},
				{Name: "proxy", Image: "traefik:v3", Meta: "8080/tcp, 443/udp, 9090/tcp"},
				{Name: "worker", Image: "build: ./worker"},
				{Name: "envport", Image: "app", Meta: "${PORT:-3000}/tcp"},
				{Name: "bare", Image: "build: ."},
			},
		},
		{name: "invalid yaml", in: "services: [\n", want: nil},
		{name: "no services", in: "version: '3'\n", want: nil},
		{name: "empty services", in: "services: {}\n", want: []ComposeService{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseComposeServices([]byte(tt.in))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got  %#v\nwant %#v", got, tt.want)
			}
		})
	}
}

func TestIsComposeFile(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"compose.yaml", true},
		{"compose.yml", true},
		{"docker-compose.yml", true},
		{"docker-compose.yaml", true},
		{"Docker-Compose.YML", true},
		{"prod.compose.yaml", true},
		{"docker-compose.prod.yml", true},
		{"deploy/compose.yaml", true},
		{"a/b/c/compose.yaml", true},
		{"a/b/c/d/compose.yaml", false},
		{"node_modules/x/compose.yaml", false},
		{".github/compose.yml", false},
		{"compose.json", false},
		{"mycompose.yaml", false},
		{".compose.yaml", false},
		{"docker-compose..yml", false},
		{"docker-compose.", false},
		{"README.md", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsComposeFile(tt.path); got != tt.want {
				t.Fatalf("IsComposeFile(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestFilterComposeFiles(t *testing.T) {
	in := []string{"z/compose.yaml", "docker-compose.prod.yml", "src/main.go", "compose.yaml", "a/b/docker-compose.yml", "a/compose.yml", "docker-compose.yml"}
	want := []string{"compose.yaml", "docker-compose.yml", "docker-compose.prod.yml", "a/compose.yml", "z/compose.yaml", "a/b/docker-compose.yml"}
	if got := FilterComposeFiles(in); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestNextPageURL(t *testing.T) {
	tests := []struct {
		name, link, want string
	}{
		{"empty", "", ""},
		{"next and last", `<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"`, "https://api.github.com/user/repos?page=2"},
		{"last page", `<https://api.github.com/user/repos?page=1>; rel="prev", <https://api.github.com/user/repos?page=1>; rel="first"`, ""},
		{"next listed last", `<https://x/?page=1>; rel="prev", <https://x/?page=3>; rel="next"`, "https://x/?page=3"},
		{"unquoted rel", `<https://x/?page=2>; rel=next`, "https://x/?page=2"},
		{"malformed", `https://x/?page=2; rel="next"`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NextPageURL(tt.link); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestListReposPagination(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			w.WriteHeader(401)
			_, _ = io.WriteString(w, `{"message":"Bad credentials"}`)
			return
		}
		if r.URL.Path != "/user/repos" || r.URL.Query().Get("per_page") != "100" {
			t.Errorf("unexpected request %s", r.URL)
		}
		page := r.URL.Query().Get("page")
		switch page {
		case "", "1":
			w.Header().Set("Link", fmt.Sprintf(`<%s/user/repos?per_page=100&page=2>; rel="next", <%s/user/repos?per_page=100&page=2>; rel="last"`, srv.URL, srv.URL))
			_, _ = io.WriteString(w, `[{"id":1,"name":"a","full_name":"o/a","owner":{"login":"o"},"description":null,"default_branch":"main","private":true,"pushed_at":"2026-01-02T03:04:05Z"}]`)
		case "2":
			_, _ = io.WriteString(w, `[{"id":2,"name":"b","full_name":"o/b","owner":{"login":"o"},"description":"B","default_branch":"dev","pushed_at":null}]`)
		}
	}))
	defer srv.Close()

	repos, err := New(srv.URL, "tok").ListRepos(context.Background(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []Repo{
		{ID: 1, Owner: "o", Name: "a", FullName: "o/a", DefaultBranch: "main", Private: true, PushedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)},
		{ID: 2, Owner: "o", Name: "b", FullName: "o/b", Description: "B", DefaultBranch: "dev"},
	}
	if !reflect.DeepEqual(repos, want) {
		t.Fatalf("got %+v", repos)
	}

	_, err = New(srv.URL, "wrong").ListRepos(context.Background(), "", false)
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 401 || !strings.Contains(err.Error(), "GitHub: bad credentials (401)") {
		t.Fatalf("err = %v", err)
	}
}

func TestRateLimitError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1700000000")
		w.WriteHeader(403)
		_, _ = io.WriteString(w, `{"message":"API rate limit exceeded for user"}`)
	}))
	defer srv.Close()
	_, _, err := New(srv.URL, "t").Viewer(context.Background())
	if err == nil || !strings.Contains(err.Error(), "rate limit") || !strings.Contains(err.Error(), "2023-11-14T22:13:20Z") {
		t.Fatalf("err = %v", err)
	}
}

func TestFileContentAndCombinedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/o/r/contents/deploy/.env.example":
			if r.Header.Get("Accept") != "application/vnd.github.raw+json" || r.URL.Query().Get("ref") != "main" {
				t.Errorf("bad request %s %v", r.URL, r.Header)
			}
			_, _ = io.WriteString(w, "A=1\n")
		case strings.HasPrefix(r.URL.Path, "/repos/o/r/contents/"):
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
		case r.URL.Path == "/repos/o/r/commits/main/status":
			_, _ = io.WriteString(w, `{"state":"success","total_count":1,"statuses":[{"state":"success"}]}`)
		case r.URL.Path == "/repos/o/r/commits/main/check-runs":
			_, _ = io.WriteString(w, `{"total_count":2,"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}`)
		case r.URL.Path == "/repos/o/r/commits/nochecks/status":
			_, _ = io.WriteString(w, `{"state":"pending","total_count":0,"statuses":[]}`)
		case r.URL.Path == "/repos/o/r/commits/nochecks/check-runs":
			_, _ = io.WriteString(w, `{"total_count":0,"check_runs":[]}`)
		case r.URL.Path == "/repos/o/r/commits/running/status":
			_, _ = io.WriteString(w, `{"state":"success","total_count":1,"statuses":[{"state":"success"}]}`)
		case r.URL.Path == "/repos/o/r/commits/running/check-runs":
			_, _ = io.WriteString(w, `{"total_count":1,"check_runs":[{"status":"in_progress","conclusion":null}]}`)
		default:
			t.Errorf("unexpected %s", r.URL)
			w.WriteHeader(500)
		}
	}))
	defer srv.Close()
	c := New(srv.URL+"/", "t")
	ctx := context.Background()

	b, err := c.FileContent(ctx, "o", "r", "deploy/.env.example", "main")
	if err != nil || string(b) != "A=1\n" {
		t.Fatalf("FileContent = %q, %v", b, err)
	}
	b, err = c.FileContent(ctx, "o", "r", "missing", "")
	if err != nil || b != nil {
		t.Fatalf("missing FileContent = %q, %v", b, err)
	}
	for ref, want := range map[string]string{"main": "failure", "nochecks": "success", "running": "pending"} {
		got, err := c.CombinedStatus(ctx, "o", "r", ref)
		if err != nil || got != want {
			t.Errorf("CombinedStatus(%s) = %q, %v; want %q", ref, got, err, want)
		}
	}
}
