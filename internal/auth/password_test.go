package auth

import "testing"

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Error("the right password was rejected")
	}
	if VerifyPassword(hash, "wrong") {
		t.Error("the wrong password was accepted")
	}
}

func TestEmptyPasswordMeansOpen(t *testing.T) {
	hash, err := HashPassword("")
	if err != nil {
		t.Fatal(err)
	}
	if hash != "" {
		t.Errorf("an empty password should produce an empty hash, got %q", hash)
	}
	if !VerifyPassword("", "anything at all") {
		t.Error("a transfer with no password should let anyone through")
	}
}

func TestHashesAreSalted(t *testing.T) {
	a, _ := HashPassword("same")
	b, _ := HashPassword("same")
	if a == b {
		t.Error("two hashes of the same password are identical, so the salt is not random")
	}
}

func TestMalformedHashesAreRejected(t *testing.T) {
	for _, bad := range []string{
		"not-a-hash",
		"$argon2id$",
		"$bcrypt$v=19$m=65536,t=2,p=4$c2FsdA$aGFzaA",
		"$argon2id$v=99$m=65536,t=2,p=4$c2FsdA$aGFzaA",
		"$argon2id$v=19$garbage$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=2,p=4$!!!$aGFzaA",
	} {
		if VerifyPassword(bad, "anything") {
			t.Errorf("malformed hash %q was accepted", bad)
		}
	}
}

func TestTokensAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 1000 {
		tok, err := Token()
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatal("duplicate token")
		}
		seen[tok] = true
	}
}
