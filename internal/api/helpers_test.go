package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/collinesfilms/fret/internal/db"
)

func TestUniqueNamesFlattensAndDeduplicates(t *testing.T) {
	// Folder drops are flattened, so collisions are expected rather than rare.
	in := []string{
		"Delivery_v3/reel.mov",
		"Delivery_v3/stills/reel.mov",
		"reel.mov",
		"notes.pdf",
		`C:\Windows\path\clip.mov`,
		"",
	}
	got := uniqueNames(in)
	want := []string{"reel.mov", "reel (1).mov", "reel (2).mov", "notes.pdf", "clip.mov", "file"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("name %d: got %q, want %q", i, got[i], want[i])
		}
	}
	seen := map[string]bool{}
	for _, n := range got {
		if seen[strings.ToLower(n)] {
			t.Errorf("%q appears twice", n)
		}
		seen[strings.ToLower(n)] = true
	}
}

func TestUniqueNamesIsCaseInsensitive(t *testing.T) {
	// A recipient on macOS or Windows would see these as one file.
	got := uniqueNames([]string{"Reel.MOV", "reel.mov"})
	if strings.EqualFold(got[0], got[1]) {
		t.Errorf("%q and %q still collide on a case-insensitive filesystem", got[0], got[1])
	}
}

func TestObjectKeyIsConfinedToItsTransfer(t *testing.T) {
	cases := []string{"reel.mov", "../../escape.mov", `..\..\escape.mov`, "a/b/c.mov", ""}
	for _, name := range cases {
		key := objectKey("TRANSFER1", "FILE1", name)
		if !strings.HasPrefix(key, "transfers/TRANSFER1/FILE1/") {
			t.Errorf("name %q produced key %q, which escapes its prefix", name, key)
		}
		if strings.Contains(key, "..") {
			t.Errorf("name %q produced key %q, which contains a traversal", name, key)
		}
	}
}

func TestExpiryTimestamp(t *testing.T) {
	base := time.Unix(1700000000, 0)
	cases := map[string]*int64{
		"24h":   ptr(base.Add(24 * time.Hour).Unix()),
		"7d":    ptr(base.Add(7 * 24 * time.Hour).Unix()),
		"30d":   ptr(base.Add(30 * 24 * time.Hour).Unix()),
		"never": nil,
	}
	for symbol, want := range cases {
		got := expiryTimestamp(symbol, base)
		if want == nil {
			if got != nil {
				t.Errorf("%q should never expire, got %v", symbol, *got)
			}
			continue
		}
		if got == nil || *got != *want {
			t.Errorf("%q: got %v, want %d", symbol, got, *want)
		}
	}
}

func TestValidExpiry(t *testing.T) {
	for _, ok := range []string{"24h", "7d", "30d", "never"} {
		if !validExpiry(ok) {
			t.Errorf("%q should be accepted", ok)
		}
	}
	for _, bad := range []string{"", "1h", "365d", "forever", "NEVER"} {
		if validExpiry(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

// Redirecting after sign-in must not become an open redirect.
func TestSafeNext(t *testing.T) {
	for _, ok := range []string{"/", "/abc123", "/settings?x=1"} {
		if safeNext(ok) != ok {
			t.Errorf("%q should be allowed", ok)
		}
	}
	for _, bad := range []string{"https://evil.test", "//evil.test", "javascript:alert(1)", "evil.test", ""} {
		if got := safeNext(bad); got != "" {
			t.Errorf("safeNext(%q) = %q, want \"\"", bad, got)
		}
	}
}

func TestAttemptLimiter(t *testing.T) {
	l := newAttemptLimiter(3, time.Minute)
	for i := range 3 {
		if !l.allow("client|transfer") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if l.allow("client|transfer") {
		t.Error("the fourth attempt should be refused")
	}
	// A different client keeps its own budget.
	if !l.allow("other|transfer") {
		t.Error("a different client should not be throttled by the first")
	}
}

func TestAttemptLimiterForgetsOldAttempts(t *testing.T) {
	l := newAttemptLimiter(2, 20*time.Millisecond)
	l.allow("k")
	l.allow("k")
	if l.allow("k") {
		t.Fatal("budget should be spent")
	}
	time.Sleep(30 * time.Millisecond)
	if !l.allow("k") {
		t.Error("the window should have reopened")
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct{ header, remote, want string }{
		{"", "10.0.0.4:51234", "10.0.0.4"},
		{"203.0.113.9", "10.0.0.1:1", "203.0.113.9"},
		{"203.0.113.9, 70.41.3.18", "10.0.0.1:1", "203.0.113.9"},
	}
	for _, c := range cases {
		r := &http.Request{Header: http.Header{}, RemoteAddr: c.remote}
		if c.header != "" {
			r.Header.Set("X-Forwarded-For", c.header)
		}
		if got := clientIP(r); got != c.want {
			t.Errorf("header %q remote %q: got %q, want %q", c.header, c.remote, got, c.want)
		}
	}
}

func TestInitials(t *testing.T) {
	cases := []struct{ name, email, want string }{
		{"Julien Marchand", "", "JM"},
		{"julien", "", "J"},
		{"", "acacciola@collines.co", "AC"},
		{"", "", "??"},
		{"Jean-Luc Godard", "", "JL"},
	}
	for _, c := range cases {
		u := &db.User{Name: c.name, Email: c.email}
		if got := u.Initials(); got != c.want {
			t.Errorf("name %q email %q: got %q, want %q", c.name, c.email, got, c.want)
		}
	}
}

func TestUnlockCookieIsPerTransfer(t *testing.T) {
	// Two open transfers must not overwrite each other's grant.
	if unlockCookie("aaa") == unlockCookie("bbb") {
		t.Error("unlock cookies collide across transfers")
	}
}

func ptr[T any](v T) *T { return &v }
