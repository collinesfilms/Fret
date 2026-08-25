package storage

import (
	"strings"
	"testing"
)

func TestPartSizeStaysUnderTheLimit(t *testing.T) {
	sizes := map[string]int64{
		"1 KB":   1 << 10,
		"100 MB": 100 << 20,
		"2 GB":   2 << 30,
		"100 GB": 100 << 30,
		"1 TB":   1 << 40,
		"10 TB":  10 << 40,
	}
	for label, size := range sizes {
		part := PartSizeFor(size)
		if part < MinPartSize {
			t.Errorf("%s: part size %d is below the S3 minimum of %d", label, part, MinPartSize)
		}
		if n := PartCount(size, part); n > maxParts {
			t.Errorf("%s: %d parts exceeds the S3 limit of %d", label, n, maxParts)
		}
	}
}

func TestPartCountCoversTheWholeFile(t *testing.T) {
	cases := []struct{ size, part int64 }{
		{0, 16 << 20},
		{1, 16 << 20},
		{16 << 20, 16 << 20},
		{(16 << 20) + 1, 16 << 20},
		{100 << 30, 16 << 20},
	}
	for _, c := range cases {
		n := PartCount(c.size, c.part)
		if n < 1 {
			t.Errorf("size %d: got %d parts, want at least 1", c.size, n)
		}
		if covered := int64(n) * c.part; c.size > 0 && covered < c.size {
			t.Errorf("size %d with %d-byte parts: %d parts cover only %d bytes", c.size, c.part, n, covered)
		}
	}
}

func TestContentDispositionHandlesAwkwardNames(t *testing.T) {
	got := contentDisposition("étalonnage — v2 \"final\".mov")
	if strings.Contains(strings.SplitN(got, "filename*=", 2)[0], `"final"`) {
		t.Errorf("quotes must be escaped out of the ASCII fallback: %s", got)
	}
	if !strings.Contains(got, "filename*=UTF-8''") {
		t.Errorf("missing the RFC 5987 form: %s", got)
	}
	if empty := contentDisposition(""); !strings.Contains(empty, `filename="download"`) {
		t.Errorf("an empty name should fall back to something usable: %s", empty)
	}
	// A newline in a name must never reach the header intact.
	if bad := contentDisposition("a\r\nX-Injected: 1"); strings.ContainsAny(bad[:strings.Index(bad, "filename*=")], "\r\n") {
		t.Errorf("header injection survived: %q", bad)
	}
}
