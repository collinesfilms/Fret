package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/slug"
)

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if err := s.oidc.Start(w, r, safeNext(r.URL.Query().Get("next"))); err != nil {
		s.log.Error("starting sign-in", "error", err)
		s.redirectWithError(w, r, "provider_unreachable")
	}
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	identity, next, err := s.oidc.Complete(w, r)
	if err != nil {
		if errors.Is(err, auth.ErrFlowExpired) {
			s.redirectWithError(w, r, "expired")
			return
		}
		s.log.Warn("sign-in failed", "error", err)
		s.redirectWithError(w, r, "failed")
		return
	}

	user, err := s.db.UpsertUser(r.Context(), identity.Subject, identity.Email, identity.Name)
	if err != nil {
		s.log.Error("recording the signed-in account", "error", err)
		s.redirectWithError(w, r, "failed")
		return
	}

	token, err := auth.Token()
	if err != nil {
		s.log.Error("session token", "error", err)
		s.redirectWithError(w, r, "failed")
		return
	}
	if err := s.db.CreateSession(r.Context(), token, user.ID, s.cfg.SessionTTL); err != nil {
		s.log.Error("creating session", "error", err)
		s.redirectWithError(w, r, "failed")
		return
	}
	s.oidc.SetSession(w, token, s.cfg.SessionTTL)

	if next == "" {
		next = "/"
	}
	http.Redirect(w, r, next, http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if token := auth.SessionToken(r); token != "" {
		if err := s.db.DeleteSession(r.Context(), token); err != nil {
			s.log.Warn("deleting session", "error", err)
		}
	}
	s.oidc.ClearSession(w)
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

// meResponse is everything the frontend needs to render the signed-in app:
// the account, its preferences, and the instance's own identity.
type meResponse struct {
	User       *db.User `json:"user"`
	Initials   string   `json:"initials"`
	Superadmin bool     `json:"superadmin"`
	AppName    string   `json:"appName"`
	Locale     string   `json:"locale"`
	PublicHost string   `json:"publicHost"`
	Region     string   `json:"region"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, u *db.User) {
	send(w, http.StatusOK, s.meFor(u))
}

func (s *Server) meFor(u *db.User) meResponse {
	host := s.cfg.PublicURL
	if parsed, err := url.Parse(s.cfg.PublicURL); err == nil && parsed.Host != "" {
		host = parsed.Host
	}
	return meResponse{
		User:       u,
		Initials:   u.Initials(),
		Superadmin: s.isSuperadmin(u),
		AppName:    s.cfg.AppName,
		Locale:     s.cfg.Locale,
		PublicHost: host,
		Region:     s.cfg.S3Region,
	}
}

type preferencesRequest struct {
	Theme         *string `json:"theme"`
	SlugStyle     *string `json:"slugStyle"`
	SlugLength    *int    `json:"slugLength"`
	DefaultExpiry *string `json:"defaultExpiry"`
}

// handlePreferences stores the settings that follow an account between
// devices. Each field is optional so the UI can save one control at a time.
func (s *Server) handlePreferences(w http.ResponseWriter, r *http.Request, u *db.User) {
	var req preferencesRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	theme := u.Theme
	if req.Theme != nil {
		switch *req.Theme {
		case "system", "light", "dark":
			theme = *req.Theme
		default:
			fail(w, http.StatusBadRequest, "theme must be system, light or dark")
			return
		}
	}
	style := u.SlugStyle
	if req.SlugStyle != nil {
		style = slug.ValidStyle(*req.SlugStyle)
	}
	length := u.SlugLength
	if req.SlugLength != nil {
		length = slug.ClampLength(*req.SlugLength)
	}
	expiry := u.DefaultExpiry
	if req.DefaultExpiry != nil {
		if !validExpiry(*req.DefaultExpiry) {
			fail(w, http.StatusBadRequest, "expiry must be 24h, 7d, 30d or never")
			return
		}
		expiry = *req.DefaultExpiry
	}

	if err := s.db.UpdatePreferences(r.Context(), u.ID, theme, style, length, expiry); err != nil {
		s.log.Error("saving preferences", "error", err)
		fail(w, http.StatusInternalServerError, "could not save your settings")
		return
	}
	u.Theme, u.SlugStyle, u.SlugLength, u.DefaultExpiry = theme, style, length, expiry
	send(w, http.StatusOK, s.meFor(u))
}

// safeNext keeps post-sign-in redirects on this site.
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		return ""
	}
	return next
}

func (s *Server) redirectWithError(w http.ResponseWriter, r *http.Request, reason string) {
	http.Redirect(w, r, "/?signin="+url.QueryEscape(reason), http.StatusFound)
}
