package slug

import (
	"strings"
	"testing"
)

func TestGenerateCodeLength(t *testing.T) {
	for _, n := range []int{4, 6, 8, 12, 24} {
		s, err := Generate(StyleCode, n)
		if err != nil {
			t.Fatalf("generate(%d): %v", n, err)
		}
		if len(s) != n {
			t.Errorf("length %d: got %q (%d chars)", n, s, len(s))
		}
		for _, r := range s {
			if !strings.ContainsRune(Alphabet, r) {
				t.Errorf("%q contains %q, outside the alphabet", s, r)
			}
		}
	}
}

func TestGenerateClampsLength(t *testing.T) {
	short, _ := Generate(StyleCode, 1)
	if len(short) != MinLength {
		t.Errorf("length 1 should clamp to %d, got %d", MinLength, len(short))
	}
	long, _ := Generate(StyleCode, 500)
	if len(long) != MaxLength {
		t.Errorf("length 500 should clamp to %d, got %d", MaxLength, len(long))
	}
}

func TestGenerateWordsShape(t *testing.T) {
	s, err := Generate(StyleWords, 0)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(s, "-")
	if len(parts) != 3 {
		t.Fatalf("want word-word-NN, got %q", s)
	}
	if parts[0] == parts[1] {
		t.Errorf("both words identical in %q", s)
	}
	if len(parts[2]) != 2 {
		t.Errorf("suffix should be zero-padded to two digits, got %q", s)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"Client Review":   "clientreview",
		"  MASTERS-hifi ": "masters-hifi",
		"a/b?c=1":         "abc1",
		"--trimmed--":     "trimmed",
		"kéêp-ascii":      "kp-ascii",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidate(t *testing.T) {
	valid := []string{"k7m2xq9p", "amber-harbor-24", "abcd", "a_b_c_1"}
	for _, s := range valid {
		if err := Validate(s); err != nil {
			t.Errorf("Validate(%q) = %v, want nil", s, err)
		}
	}
	invalid := []string{"", "abc", "api", "admin", "Has-Caps", "has space", strings.Repeat("a", 65)}
	for _, s := range invalid {
		if err := Validate(s); err == nil {
			t.Errorf("Validate(%q) = nil, want an error", s)
		}
	}
}

func TestGenerateIsNotRepetitive(t *testing.T) {
	seen := map[string]bool{}
	for range 500 {
		s, err := Generate(StyleCode, DefaultLength)
		if err != nil {
			t.Fatal(err)
		}
		if seen[s] {
			t.Fatalf("collision on %q within 500 draws", s)
		}
		seen[s] = true
	}
}
