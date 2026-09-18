# syntax=docker/dockerfile:1
# Build context: the server/ directory.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG DOCKHAND_VERSION=1.0.0
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags "-s -w -X main.version=${DOCKHAND_VERSION}" \
      -o /out/dockhand ./cmd/dockhand

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata openssh-client docker-cli docker-cli-compose postgresql17-client \
    && mkdir -p /opt/dockhand/stacks /opt/dockhand/backups
COPY --from=build /out/dockhand /usr/local/bin/dockhand
ENV DOCKHAND_LISTEN=:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/dockhand"]
