// Package config loads Fret's runtime configuration from the environment.
//
// Everything an operator needs to change lives here. Per-user preferences
// (theme, slug style, default expiry) deliberately do not: those are stored
// per account in SQLite so they follow the user between devices.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Identity and presentation.
	AppName    string
	PublicURL  string // canonical origin, e.g. https://fret.li
	Locale     string // UI language: en, fr
	ListenAddr string

	// Storage. Fret signs browser-facing URLs against S3Public and talks to
	// S3Internal itself. With MinIO on a LAN these differ: the browser needs a
	// routable hostname, the server prefers the local address.
	S3Public        string
	S3Internal      string
	S3Region        string
	S3Bucket        string
	S3AccessKey     string
	S3SecretKey     string
	S3ForcePath     bool
	PresignUpload   time.Duration
	PresignDownload time.Duration

	// Auth.
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURL  string
	OIDCScopes       []string
	SessionTTL       time.Duration
	SessionSecret    []byte

	// Operations.
	Superadmin     string // OIDC subject or email
	DataDir        string
	SweepInterval  time.Duration
	OrphanMaxAge   time.Duration
	ZipConcurrency int

	Dev bool
}

// Load reads configuration, applies defaults and fails loudly on anything
// missing that has no safe default.
func Load() (*Config, error) {
	c := &Config{
		AppName:        env("FRET_APP_NAME", "Fret"),
		PublicURL:      strings.TrimRight(env("FRET_PUBLIC_URL", "http://localhost:8080"), "/"),
		Locale:         env("FRET_LOCALE", "en"),
		ListenAddr:     env("FRET_LISTEN", ":8080"),
		S3Region:       env("FRET_S3_REGION", "us-east-1"),
		S3Bucket:       env("FRET_S3_BUCKET", ""),
		S3AccessKey:    env("FRET_S3_ACCESS_KEY", ""),
		S3SecretKey:    env("FRET_S3_SECRET_KEY", ""),
		S3ForcePath:    envBool("FRET_S3_FORCE_PATH_STYLE", true),
		OIDCIssuer:     env("FRET_OIDC_ISSUER", ""),
		OIDCClientID:   env("FRET_OIDC_CLIENT_ID", ""),
		Superadmin:     env("FRET_SUPERADMIN", ""),
		DataDir:        env("FRET_DATA_DIR", "/data"),
		ZipConcurrency: envInt("FRET_ZIP_READAHEAD", 2),
		Dev:            envBool("FRET_DEV", false),
	}
	c.OIDCClientSecret = os.Getenv("FRET_OIDC_CLIENT_SECRET")

	c.S3Public = strings.TrimRight(env("FRET_S3_PUBLIC_ENDPOINT", env("FRET_S3_ENDPOINT", "")), "/")
	c.S3Internal = strings.TrimRight(env("FRET_S3_INTERNAL_ENDPOINT", c.S3Public), "/")

	c.OIDCRedirectURL = env("FRET_OIDC_REDIRECT_URL", c.PublicURL+"/auth/callback")
	c.OIDCScopes = splitList(env("FRET_OIDC_SCOPES", "openid,profile,email"))

	c.PresignUpload = envDur("FRET_PRESIGN_UPLOAD_TTL", 6*time.Hour)
	c.PresignDownload = envDur("FRET_PRESIGN_DOWNLOAD_TTL", 15*time.Minute)
	c.SessionTTL = envDur("FRET_SESSION_TTL", 720*time.Hour)
	c.SweepInterval = envDur("FRET_SWEEP_INTERVAL", 10*time.Minute)
	c.OrphanMaxAge = envDur("FRET_ORPHAN_MAX_AGE", 24*time.Hour)

	secret := os.Getenv("FRET_SESSION_SECRET")
	if secret == "" && !c.Dev {
		return nil, fmt.Errorf("FRET_SESSION_SECRET is required (32+ random bytes; `openssl rand -hex 32`)")
	}
	if secret == "" {
		secret = "development-only-insecure-session-secret"
	}
	if len(secret) < 32 && !c.Dev {
		return nil, fmt.Errorf("FRET_SESSION_SECRET must be at least 32 characters")
	}
	c.SessionSecret = []byte(secret)

	for _, req := range []struct{ name, val string }{
		{"FRET_S3_BUCKET", c.S3Bucket},
		{"FRET_S3_ACCESS_KEY", c.S3AccessKey},
		{"FRET_S3_SECRET_KEY", c.S3SecretKey},
		{"FRET_OIDC_ISSUER", c.OIDCIssuer},
		{"FRET_OIDC_CLIENT_ID", c.OIDCClientID},
	} {
		if req.val == "" {
			return nil, fmt.Errorf("%s is required", req.name)
		}
	}
	if c.ZipConcurrency < 1 {
		c.ZipConcurrency = 1
	}
	return c, nil
}

// PresignEndpoint is the S3 address the browser will be pointed at.
func (c *Config) PresignEndpoint() string { return c.S3Public }

// ServerEndpoint is the S3 address this process uses for its own reads.
func (c *Config) ServerEndpoint() string {
	if c.S3Internal != "" {
		return c.S3Internal
	}
	return c.S3Public
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k))); err == nil {
		return n
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(os.Getenv(k))); err == nil && d > 0 {
		return d
	}
	return def
}

func splitList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
