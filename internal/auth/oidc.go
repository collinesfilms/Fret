package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	sessionCookie = "fret_session"
	flowCookie    = "fret_flow"
	flowTTL       = 10 * time.Minute
)

// Provider performs the OIDC authorization-code flow with PKCE.
//
// Discovery is lazy and retried: in a Docker Compose stack Fret often starts
// before the identity provider is listening, and a hard failure at boot would
// turn a startup race into an outage.
type Provider struct {
	issuer       string
	clientID     string
	clientSecret string
	redirectURL  string
	scopes       []string
	secret       []byte
	secureCookie bool

	mu       sync.Mutex
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config
}

type ProviderOptions struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	CookieSecret []byte
	SecureCookie bool
}

func NewProvider(o ProviderOptions) *Provider {
	return &Provider{
		issuer:       o.Issuer,
		clientID:     o.ClientID,
		clientSecret: o.ClientSecret,
		redirectURL:  o.RedirectURL,
		scopes:       o.Scopes,
		secret:       o.CookieSecret,
		secureCookie: o.SecureCookie,
	}
}

// discover resolves the provider metadata, caching the result.
func (p *Provider) discover(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.provider != nil {
		return nil
	}
	prov, err := oidc.NewProvider(ctx, p.issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery against %s: %w", p.issuer, err)
	}
	p.provider = prov
	p.verifier = prov.Verifier(&oidc.Config{ClientID: p.clientID})
	p.oauth = &oauth2.Config{
		ClientID:     p.clientID,
		ClientSecret: p.clientSecret,
		Endpoint:     prov.Endpoint(),
		RedirectURL:  p.redirectURL,
		Scopes:       p.scopes,
	}
	return nil
}

// Warm attempts discovery ahead of the first sign-in, retrying in the
// background so a provider that is slow to boot does not block Fret.
func (p *Provider) Warm(ctx context.Context, onError func(error)) {
	go func() {
		delay := time.Second
		for {
			if err := p.discover(ctx); err == nil {
				return
			} else if onError != nil {
				onError(err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if delay < time.Minute {
				delay *= 2
			}
		}
	}()
}

// flowState is the short-lived data carried between the redirect out and the
// callback: it lives in a signed cookie rather than server memory, so a
// restart mid-sign-in does not strand the user.
type flowState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	Next     string `json:"n,omitempty"`
	Expires  int64  `json:"e"`
}

// Start redirects the browser to the provider's authorization endpoint.
func (p *Provider) Start(w http.ResponseWriter, r *http.Request, next string) error {
	if err := p.discover(r.Context()); err != nil {
		return err
	}
	state, err := Token()
	if err != nil {
		return err
	}
	verifier := oauth2.GenerateVerifier()

	payload, err := json.Marshal(flowState{
		State:    state,
		Verifier: verifier,
		Next:     next,
		Expires:  time.Now().Add(flowTTL).Unix(),
	})
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     flowCookie,
		Value:    p.sign(payload),
		Path:     "/",
		MaxAge:   int(flowTTL.Seconds()),
		HttpOnly: true,
		Secure:   p.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})

	url := p.oauth.AuthCodeURL(state, oauth2.AccessTypeOnline, oauth2.S256ChallengeOption(verifier))
	http.Redirect(w, r, url, http.StatusFound)
	return nil
}

// Identity is what Fret keeps from the provider: a stable subject plus enough
// to render the avatar.
type Identity struct {
	Subject string
	Email   string
	Name    string
}

var ErrFlowExpired = errors.New("sign-in took too long, please try again")

// Complete handles the provider's callback and returns the verified identity
// along with the path the user was originally heading for.
func (p *Provider) Complete(w http.ResponseWriter, r *http.Request) (*Identity, string, error) {
	if err := p.discover(r.Context()); err != nil {
		return nil, "", err
	}
	cookie, err := r.Cookie(flowCookie)
	if err != nil {
		return nil, "", ErrFlowExpired
	}
	// The flow cookie is single-use whatever happens next.
	http.SetCookie(w, &http.Cookie{
		Name: flowCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: p.secureCookie, SameSite: http.SameSiteLaxMode,
	})

	payload, ok := p.unsign(cookie.Value)
	if !ok {
		return nil, "", errors.New("sign-in state failed verification")
	}
	var flow flowState
	if err := json.Unmarshal(payload, &flow); err != nil {
		return nil, "", errors.New("sign-in state was unreadable")
	}
	if time.Now().Unix() > flow.Expires {
		return nil, "", ErrFlowExpired
	}
	// A refusal from the provider carries no code, so surface it before the
	// state check to avoid reporting a misleading mismatch.
	if desc := r.URL.Query().Get("error"); desc != "" {
		return nil, "", fmt.Errorf("provider refused sign-in: %s", sanitizeErrorCode(desc))
	}
	if !subtleEqual(flow.State, r.URL.Query().Get("state")) {
		return nil, "", errors.New("sign-in state did not match")
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		return nil, "", errors.New("provider returned no authorization code")
	}

	token, err := p.oauth.Exchange(r.Context(), code, oauth2.VerifierOption(flow.Verifier))
	if err != nil {
		return nil, "", fmt.Errorf("code exchange: %w", err)
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok {
		return nil, "", errors.New("provider returned no id_token")
	}
	idToken, err := p.verifier.Verify(r.Context(), rawID)
	if err != nil {
		return nil, "", fmt.Errorf("id_token verification: %w", err)
	}

	var claims struct {
		Email             string `json:"email"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
		GivenName         string `json:"given_name"`
		FamilyName        string `json:"family_name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, "", fmt.Errorf("reading claims: %w", err)
	}

	name := firstNonEmpty(
		claims.Name,
		strings.TrimSpace(claims.GivenName+" "+claims.FamilyName),
		claims.PreferredUsername,
		claims.Email,
	)
	return &Identity{Subject: idToken.Subject, Email: claims.Email, Name: name}, flow.Next, nil
}

// SetSession writes the session cookie.
func (p *Provider) SetSession(w http.ResponseWriter, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   p.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func (p *Provider) ClearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: p.secureCookie, SameSite: http.SameSiteLaxMode,
	})
}

// SessionToken reads the session cookie, if present.
func SessionToken(r *http.Request) string {
	if c, err := r.Cookie(sessionCookie); err == nil {
		return c.Value
	}
	return ""
}

// sign appends an HMAC so a cookie's contents cannot be forged.
func (p *Provider) sign(payload []byte) string {
	mac := hmac.New(sha256.New, p.secret)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (p *Provider) unsign(value string) ([]byte, bool) {
	body, sig, ok := strings.Cut(value, ".")
	if !ok {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, false
	}
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return nil, false
	}
	mac := hmac.New(sha256.New, p.secret)
	mac.Write(payload)
	if !hmac.Equal(mac.Sum(nil), want) {
		return nil, false
	}
	return payload, true
}

func subtleEqual(a, b string) bool {
	return len(a) == len(b) && hmac.Equal([]byte(a), []byte(b))
}

// sanitizeErrorCode keeps a provider-supplied error readable without letting
// arbitrary text reach the user: OAuth error codes are short and alphanumeric.
func sanitizeErrorCode(code string) string {
	if len(code) > 64 {
		code = code[:64]
	}
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			return r
		}
		return -1
	}, code)
	if clean == "" {
		return "unspecified"
	}
	return clean
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return "user"
}
