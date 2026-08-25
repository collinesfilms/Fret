// Package api exposes Fret's HTTP surface: the JSON API the app speaks, the
// public recipient endpoints, and the embedded single-page frontend.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/config"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/storage"
)

type Server struct {
	cfg   *config.Config
	db    *db.DB
	store *storage.Store
	oidc  *auth.Provider
	log   *slog.Logger

	usage   *usageCache
	unlocks *attemptLimiter
}

func New(cfg *config.Config, database *db.DB, store *storage.Store, log *slog.Logger) *Server {
	secure := strings.HasPrefix(cfg.PublicURL, "https://")
	return &Server{
		cfg:   cfg,
		db:    database,
		store: store,
		log:   log,
		oidc: auth.NewProvider(auth.ProviderOptions{
			Issuer:       cfg.OIDCIssuer,
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			RedirectURL:  cfg.OIDCRedirectURL,
			Scopes:       cfg.OIDCScopes,
			CookieSecret: cfg.SessionSecret,
			SecureCookie: secure,
		}),
		usage:   &usageCache{ttl: 2 * time.Minute},
		unlocks: newAttemptLimiter(8, 10*time.Minute),
	}
}

// Warm kicks off OIDC discovery in the background.
func (s *Server) Warm(ctx context.Context) {
	s.oidc.Warm(ctx, func(err error) {
		s.log.Warn("oidc discovery failed, will retry", "error", err)
	})
}

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Sign-in. The provider owns credentials; Fret only records the result.
	mux.HandleFunc("GET /auth/login", s.handleLogin)
	mux.HandleFunc("GET /auth/callback", s.handleCallback)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)

	// The signed-in app.
	mux.Handle("GET /api/me", s.authed(s.handleMe))
	mux.Handle("PATCH /api/me/preferences", s.authed(s.handlePreferences))
	mux.Handle("GET /api/transfers", s.authed(s.handleListTransfers))
	mux.Handle("POST /api/transfers", s.authed(s.handleCreateTransfer))
	mux.Handle("GET /api/transfers/resumable", s.authed(s.handleResumable))
	mux.Handle("GET /api/transfers/{id}", s.authed(s.handleGetTransfer))
	mux.Handle("PATCH /api/transfers/{id}", s.authed(s.handleUpdateTransfer))
	mux.Handle("DELETE /api/transfers/{id}", s.authed(s.handleDeleteTransfer))
	mux.Handle("POST /api/transfers/{id}/parts", s.authed(s.handlePresignParts))
	mux.Handle("POST /api/transfers/{id}/files/{fileID}/parts", s.authed(s.handleRecordPart))
	mux.Handle("POST /api/transfers/{id}/files/{fileID}/complete", s.authed(s.handleCompleteFile))
	mux.Handle("POST /api/transfers/{id}/finalize", s.authed(s.handleFinalize))
	mux.Handle("GET /api/admin/stats", s.authed(s.handleAdminStats))

	// The public recipient side. No session, no account.
	mux.HandleFunc("GET /api/t/{slug}", s.handlePublicTransfer)
	mux.HandleFunc("POST /api/t/{slug}/unlock", s.handleUnlock)
	mux.HandleFunc("GET /api/t/{slug}/files/{fileID}", s.handlePublicFile)
	mux.HandleFunc("GET /api/t/{slug}/archive", s.handleArchive)

	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/health", s.handleHealth)

	// Everything else is the SPA, including /{slug} recipient links.
	mux.Handle("/", s.spaHandler())

	return s.recover(s.logRequests(mux))
}

// ---------- middleware ----------

type ctxKey int

const userKey ctxKey = iota

// authed resolves the session cookie to an account, rejecting anonymous calls.
func (s *Server) authed(h func(http.ResponseWriter, *http.Request, *db.User)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := auth.SessionToken(r)
		if token == "" {
			fail(w, http.StatusUnauthorized, "not signed in")
			return
		}
		user, err := s.db.SessionUser(r.Context(), token)
		if err != nil {
			// An expired or unknown session is indistinguishable from none.
			s.oidc.ClearSession(w)
			fail(w, http.StatusUnauthorized, "not signed in")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), userKey, user)), user)
	})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		// Successful asset and API chatter is noise; log what matters.
		if rec.status >= 400 || time.Since(start) > time.Second {
			s.log.Info("request",
				"method", r.Method, "path", r.URL.Path,
				"status", rec.status, "duration", time.Since(start).Round(time.Millisecond))
		}
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				s.log.Error("panic serving request", "path", r.URL.Path, "panic", p)
				fail(w, http.StatusInternalServerError, "something went wrong")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
		r.ResponseWriter.WriteHeader(code)
	}
}

// Flush and Unwrap keep streaming responses working through the wrapper.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// ---------- responses ----------

func send(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

func fail(w http.ResponseWriter, status int, message string) {
	send(w, status, apiError{Error: message})
}

func failCode(w http.ResponseWriter, status int, code, message string) {
	send(w, status, apiError{Error: message, Code: code})
}

// decode reads a JSON body with a size ceiling, since none of Fret's requests
// are large — the bytes go to S3, not through here.
func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("malformed request: %w", err)
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	send(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---------- small shared helpers ----------

// usageCache holds the bucket total, which costs a full object listing.
type usageCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	at      time.Time
	bytes   int64
	objects int64
}

func (c *usageCache) get(ctx context.Context, store *storage.Store) (int64, int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < c.ttl {
		return c.bytes, c.objects, nil
	}
	bytes, objects, err := store.Usage(ctx)
	if err != nil {
		return c.bytes, c.objects, err
	}
	c.bytes, c.objects, c.at = bytes, objects, time.Now()
	return bytes, objects, nil
}

// attemptLimiter throttles password guesses per client and transfer.
type attemptLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	tries  map[string][]time.Time
	lastGC time.Time
}

func newAttemptLimiter(max int, window time.Duration) *attemptLimiter {
	return &attemptLimiter{max: max, window: window, tries: map[string][]time.Time{}, lastGC: time.Now()}
}

// allow records an attempt and reports whether it is within the budget.
func (l *attemptLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)

	if now.Sub(l.lastGC) > l.window {
		for k, times := range l.tries {
			if len(times) == 0 || times[len(times)-1].Before(cutoff) {
				delete(l.tries, k)
			}
		}
		l.lastGC = now
	}

	kept := l.tries[key][:0]
	for _, t := range l.tries[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.tries[key] = kept
		return false
	}
	l.tries[key] = append(kept, now)
	return true
}

// clientIP identifies the caller for rate limiting, trusting a proxy header
// only for its first hop.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first, _, ok := strings.Cut(fwd, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(fwd)
	}
	host, _, ok := strings.Cut(r.RemoteAddr, ":")
	if !ok {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) isSuperadmin(u *db.User) bool {
	admin := strings.TrimSpace(s.cfg.Superadmin)
	if admin == "" {
		return false
	}
	return admin == u.Subject || strings.EqualFold(admin, u.Email)
}

var errNotFound = errors.New("not found")
