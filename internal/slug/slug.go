// Package slug mints and validates the short public identifiers that appear
// in a transfer's link.
//
// Two styles, chosen per user:
//
//	code   short random string, the default: fret.li/k7m2xq9p
//	words  readable pairs for links read aloud: fret.li/amber-harbor-24
package slug

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// Alphabet omits characters that are easily confused when a link is read from
// a screen or dictated: 0/O, 1/l/I. The 31 symbols that remain carry ~4.95
// bits each, so the 8-character default is a ~40-bit identifier.
const Alphabet = "23456789abcdefghjkmnpqrstuvwxyz"

var words = []string{
	"amber", "quiet", "north", "ember", "linen", "harbor", "signal", "drift",
	"copper", "marlow", "stone", "vellum", "orbit", "cadence", "basalt", "pallet",
	"willow", "cobalt", "ridge", "lantern", "meadow", "cinder", "thicket", "prairie",
	"summit", "hollow", "juniper", "beacon", "tundra", "current", "anchor", "vessel",
}

const (
	StyleCode  = "code"
	StyleWords = "words"

	MinLength     = 4
	MaxLength     = 24
	DefaultLength = 8
)

var ErrInvalid = errors.New("invalid slug")

// Generate produces a slug in the requested style. For StyleCode, length is
// the number of characters; StyleWords ignores it.
func Generate(style string, length int) (string, error) {
	if style == StyleWords {
		return generateWords()
	}
	if length < MinLength {
		length = MinLength
	}
	if length > MaxLength {
		length = MaxLength
	}
	return generateCode(length)
}

func generateCode(length int) (string, error) {
	var b strings.Builder
	b.Grow(length)
	for range length {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(Alphabet))))
		if err != nil {
			return "", fmt.Errorf("slug entropy: %w", err)
		}
		b.WriteByte(Alphabet[n.Int64()])
	}
	return b.String(), nil
}

func generateWords() (string, error) {
	pick := func() (string, error) {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
		if err != nil {
			return "", err
		}
		return words[n.Int64()], nil
	}
	first, err := pick()
	if err != nil {
		return "", err
	}
	second := first
	for second == first {
		if second, err = pick(); err != nil {
			return "", err
		}
	}
	n, err := rand.Int(rand.Reader, big.NewInt(90))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s-%02d", first, second, n.Int64()+10), nil
}

// Normalize lowercases and strips anything a slug may not contain. The input
// field applies the same rule as you type, so this is the server's agreement
// with that behaviour rather than a second, stricter one.
func Normalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), "-_")
}

// Reserved slugs would otherwise shadow the application's own routes.
var reserved = map[string]bool{
	"api": true, "auth": true, "assets": true, "static": true, "health": true,
	"favicon.ico": true, "robots.txt": true, "admin": true, "settings": true,
	"login": true, "logout": true, "index.html": true, "manifest.json": true,
}

// Validate checks a user-supplied slug.
func Validate(s string) error {
	if len(s) < MinLength {
		return fmt.Errorf("%w: needs at least %d characters", ErrInvalid, MinLength)
	}
	if len(s) > 64 {
		return fmt.Errorf("%w: too long", ErrInvalid)
	}
	if reserved[s] {
		return fmt.Errorf("%w: reserved", ErrInvalid)
	}
	if Normalize(s) != s {
		return fmt.Errorf("%w: only a-z, 0-9, - and _", ErrInvalid)
	}
	return nil
}

// ValidStyle keeps an unknown preference from reaching the generator.
func ValidStyle(s string) string {
	if s == StyleWords {
		return StyleWords
	}
	return StyleCode
}

// ClampLength keeps a user's chosen length inside the supported range.
func ClampLength(n int) int {
	if n < MinLength {
		return MinLength
	}
	if n > MaxLength {
		return MaxLength
	}
	return n
}
