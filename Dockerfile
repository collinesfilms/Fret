# Fret builds to a single static binary with the frontend embedded, so the
# runtime image carries no Node, no assets directory and nothing to serve them
# with — just the binary, CA certificates and a data volume.

# ---- frontend ----
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Vite writes into the Go module's embed directory.
RUN npm run build

# ---- binary ----
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /internal/api/dist ./internal/api/dist
ARG VERSION=dev
# CGO stays off: the SQLite driver is pure Go, so the result is a static binary
# that runs on any base image.
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /fret ./cmd/fret

# ---- runtime ----
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 10001 fret && \
    mkdir -p /data && chown fret:fret /data
COPY --from=build /fret /usr/local/bin/fret
USER fret
VOLUME ["/data"]
EXPOSE 8080
ENV FRET_DATA_DIR=/data FRET_LISTEN=:8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/fret"]
