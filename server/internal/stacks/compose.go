package stacks

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"dockhand/internal/model"
)

var yamlLineRe = regexp.MustCompile(`line (\d+)`)

// Validate parses a compose file and performs basic schema checks.
func Validate(content string) model.ComposeValidation {
	v := model.ComposeValidation{Services: []model.ComposeServiceInfo{}}
	fail := func(line int, format string, a ...any) model.ComposeValidation {
		v.OK, v.Error, v.Line = false, fmt.Sprintf(format, a...), line
		return v
	}
	if strings.TrimSpace(content) == "" {
		return fail(0, "the compose file is empty")
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		msg := strings.TrimPrefix(err.Error(), "yaml: ")
		line := 0
		if m := yamlLineRe.FindStringSubmatch(msg); m != nil {
			line, _ = strconv.Atoi(m[1])
		}
		return fail(line, "YAML error: %s", msg)
	}
	if len(doc.Content) == 0 {
		return fail(0, "the compose file is empty")
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return fail(root.Line, "the top level must be a mapping (e.g. services: …)")
	}
	var services *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		k := root.Content[i]
		switch k.Value {
		case "services":
			services = root.Content[i+1]
		case "version", "name", "networks", "volumes", "configs", "secrets", "include":
		default:
			if !strings.HasPrefix(k.Value, "x-") {
				return fail(k.Line, "unknown top-level key %q", k.Value)
			}
		}
	}
	if services == nil {
		return fail(root.Line, "missing a top-level \"services\" section")
	}
	if services.Kind != yaml.MappingNode || len(services.Content) == 0 {
		return fail(services.Line, "\"services\" must define at least one service")
	}
	for i := 0; i+1 < len(services.Content); i += 2 {
		nameNode, svc := services.Content[i], services.Content[i+1]
		name := nameNode.Value
		if svc.Kind != yaml.MappingNode {
			return fail(nameNode.Line, "service %q must be a mapping", name)
		}
		info := model.ComposeServiceInfo{Name: name, Ports: []string{}}
		hasBuild := false
		for j := 0; j+1 < len(svc.Content); j += 2 {
			k, val := svc.Content[j], svc.Content[j+1]
			switch k.Value {
			case "image":
				info.Image = val.Value
			case "build":
				hasBuild = true
			case "ports":
				if val.Kind != yaml.SequenceNode {
					return fail(k.Line, "service %q: ports must be a list", name)
				}
				for _, p := range val.Content {
					switch p.Kind {
					case yaml.ScalarNode:
						info.Ports = append(info.Ports, p.Value)
					case yaml.MappingNode:
						var pub, tgt, proto string
						for x := 0; x+1 < len(p.Content); x += 2 {
							switch p.Content[x].Value {
							case "published":
								pub = p.Content[x+1].Value
							case "target":
								tgt = p.Content[x+1].Value
							case "protocol":
								proto = p.Content[x+1].Value
							}
						}
						s := tgt
						if pub != "" {
							s = pub + ":" + tgt
						}
						if proto != "" && proto != "tcp" {
							s += "/" + proto
						}
						info.Ports = append(info.Ports, s)
					}
				}
			case "environment":
				if val.Kind != yaml.SequenceNode && val.Kind != yaml.MappingNode {
					return fail(k.Line, "service %q: environment must be a list or mapping", name)
				}
			case "volumes", "networks", "depends_on", "command", "entrypoint", "labels":
			}
		}
		if info.Image == "" && !hasBuild {
			return fail(nameNode.Line, "service %q needs an image or a build section", name)
		}
		if info.Image == "" {
			info.Image = "(build)"
		}
		v.Services = append(v.Services, info)
	}
	v.OK = true
	return v
}

// Template is a starter compose file.
var Templates = []model.ComposeTemplate{
	{ID: "blank", Label: "Blank", Content: `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`},
	{ID: "webapp-postgres", Label: "Web app + Postgres", Content: `services:
  app:
    image: ghcr.io/example/webapp:latest
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:-change-me}@db:5432/app
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  db-data:
`},
	{ID: "static-nginx", Label: "Static site (nginx)", Content: `services:
  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./public:/usr/share/nginx/html:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/"]
      interval: 30s
      timeout: 5s
      retries: 3
`},
	{ID: "traefik", Label: "Reverse proxy (traefik)", Content: `services:
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --api.dashboard=true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    labels:
      - traefik.enable=true
      - traefik.http.routers.dashboard.rule=Host(` + "`traefik.home.arpa`" + `)
      - traefik.http.routers.dashboard.service=api@internal

volumes:
  letsencrypt:
`},
	{ID: "paperless", Label: "Paperless-ngx-like app", Content: `services:
  broker:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redisdata:/data

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: paperless
      POSTGRES_USER: paperless
      POSTGRES_PASSWORD: ${DB_PASSWORD:-paperless}
    volumes:
      - pgdata:/var/lib/postgresql/data

  webserver:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    restart: unless-stopped
    depends_on:
      - db
      - broker
    ports:
      - "8000:8000"
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_DBHOST: db
      PAPERLESS_DBPASS: ${DB_PASSWORD:-paperless}
      PAPERLESS_SECRET_KEY: ${SECRET_KEY:-change-me}
      PAPERLESS_TIME_ZONE: UTC
    volumes:
      - data:/usr/src/paperless/data
      - media:/usr/src/paperless/media
      - ./consume:/usr/src/paperless/consume
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:8000"]
      interval: 30s
      timeout: 10s
      retries: 5

volumes:
  data:
  media:
  pgdata:
  redisdata:
`},
}
