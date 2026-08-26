package config

import "testing"

func TestLocaleNormalises(t *testing.T) {
	for in, want := range map[string]string{
		"fr": "fr", "FR": "fr", "fr-FR": "fr", "fr_CA": "fr", " Fr ": "fr",
		"en": "en", "EN": "en", "en-GB": "en",
		"de": "en", "": "en", "xx": "en", "fr.UTF-8": "fr",
	} {
		if got := Locale(in); got != want {
			t.Errorf("Locale(%q) = %q, want %q", in, got, want)
		}
	}
}
