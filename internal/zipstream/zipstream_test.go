package zipstream

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// fakeSource builds an Opener over in-memory contents.
func fakeSource(contents [][]byte) Opener {
	return func(_ context.Context, i int) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(contents[i])), nil
	}
}

func build(t *testing.T, names []string, contents [][]byte) ([]Entry, *bytes.Buffer) {
	t.Helper()
	entries := make([]Entry, len(names))
	for i, n := range names {
		entries[i] = Entry{Name: n, Size: int64(len(contents[i])), Modified: time.Unix(1700000000, 0)}
	}
	var buf bytes.Buffer
	if err := Stream(context.Background(), &buf, entries, fakeSource(contents)); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	return entries, &buf
}

// The whole point of the package: the size must be knowable before any byte
// is written, because it is sent as Content-Length.
func TestSizeMatchesBytesWritten(t *testing.T) {
	cases := []struct {
		label string
		names []string
		sizes []int
	}{
		{"single small file", []string{"a.txt"}, []int{11}},
		{"several files", []string{"reel.mov", "cover.png", "notes.pdf"}, []int{4096, 173, 9001}},
		{"empty file among others", []string{"zero.bin", "one.bin"}, []int{0, 1}},
		{"long name", []string{strings.Repeat("n", 200) + ".mov"}, []int{64}},
		{"unicode name", []string{"étalonnage — v2 (final).mov"}, []int{128}},
		{"no files", []string{}, []int{}},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			contents := make([][]byte, len(tc.sizes))
			for i, n := range tc.sizes {
				contents[i] = bytes.Repeat([]byte{byte(i + 1)}, n)
			}
			entries, buf := build(t, tc.names, contents)
			want := Size(entries)
			if got := int64(buf.Len()); got != want {
				t.Errorf("Size() predicted %d bytes, Stream wrote %d (off by %d)", want, got, got-want)
			}
		})
	}
}

func TestArchiveIsReadable(t *testing.T) {
	names := []string{"reel_autumn_v4.mov", "cover_still_4k.png", "grade notes.pdf"}
	contents := [][]byte{
		bytes.Repeat([]byte("PRORES-"), 1500),
		bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47}, 700),
		[]byte("%PDF-1.7 grade notes"),
	}
	_, buf := build(t, names, contents)

	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("the archive does not parse: %v", err)
	}
	if len(r.File) != len(names) {
		t.Fatalf("got %d entries, want %d", len(r.File), len(names))
	}
	for i, f := range r.File {
		if f.Name != names[i] {
			t.Errorf("entry %d named %q, want %q", i, f.Name, names[i])
		}
		if f.Method != zip.Store {
			t.Errorf("entry %q uses method %d, want Store", f.Name, f.Method)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %q: %v", f.Name, err)
		}
		got, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %q: %v", f.Name, err)
		}
		if !bytes.Equal(got, contents[i]) {
			t.Errorf("entry %q: content mismatch (%d bytes vs %d)", f.Name, len(got), len(contents[i]))
		}
	}
}

// CRC values live in the data descriptor and the central directory; a reader
// validates them on Close, so corruption surfaces there.
func TestCRCIsCorrect(t *testing.T) {
	contents := [][]byte{bytes.Repeat([]byte("x"), 5000)}
	_, buf := build(t, []string{"x.bin"}, contents)

	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	rc, err := r.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, rc); err != nil {
		t.Fatalf("reading the entry failed: %v", err)
	}
	if err := rc.Close(); err != nil {
		t.Errorf("checksum rejected on close: %v", err)
	}
}

func TestEmptyArchiveIsValid(t *testing.T) {
	entries, buf := build(t, nil, nil)
	if got, want := int64(buf.Len()), Size(entries); got != want {
		t.Errorf("empty archive is %d bytes, predicted %d", got, want)
	}
	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("empty archive does not parse: %v", err)
	}
	if len(r.File) != 0 {
		t.Errorf("empty archive reports %d entries", len(r.File))
	}
}

// A source that disagrees with its declared size would break the
// Content-Length promise, so it must fail loudly rather than send short.
func TestTruncatedSourceFails(t *testing.T) {
	entries := []Entry{{Name: "short.bin", Size: 1000}}
	open := func(_ context.Context, _ int) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(make([]byte, 400))), nil
	}
	err := Stream(context.Background(), io.Discard, entries, open)
	if err == nil {
		t.Fatal("want an error for a short source, got nil")
	}
	if !strings.Contains(err.Error(), "truncated") {
		t.Errorf("error should name the truncation, got %v", err)
	}
}

func TestOverlongSourceFails(t *testing.T) {
	entries := []Entry{{Name: "long.bin", Size: 100}}
	open := func(_ context.Context, _ int) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(make([]byte, 900))), nil
	}
	err := Stream(context.Background(), io.Discard, entries, open)
	if err == nil {
		t.Fatal("want an error for an over-long source, got nil")
	}
}

func TestOpenerErrorPropagates(t *testing.T) {
	entries := []Entry{{Name: "gone.bin", Size: 10}}
	open := func(_ context.Context, _ int) (io.ReadCloser, error) {
		return nil, fmt.Errorf("object missing from bucket")
	}
	err := Stream(context.Background(), io.Discard, entries, open)
	if err == nil || !strings.Contains(err.Error(), "object missing") {
		t.Fatalf("want the underlying error, got %v", err)
	}
}

func TestCancellationStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	entries := []Entry{{Name: "a", Size: 1}}
	if err := Stream(ctx, io.Discard, entries, fakeSource([][]byte{{1}})); err == nil {
		t.Error("a cancelled context should abort the stream")
	}
}

func TestNamesAreSanitised(t *testing.T) {
	cases := map[string]string{
		`..\..\etc\passwd`: "etc/passwd",
		"/absolute/path":   "absolute/path",
		"":                 "file",
		"....//":           "file",
		"../../../":        "file",
		"a/../../b":        "a/b",
		"./x/./y":          "x/y",
		"  spaced  ":       "spaced",
	}
	for in, want := range cases {
		if got := zipName(in); got != want {
			t.Errorf("zipName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Exercises the zip64 path with an entry past the 4 GB boundary, streaming
// zeroes rather than allocating them.
func TestLargeEntryUsesZip64(t *testing.T) {
	if testing.Short() {
		t.Skip("streams 4 GB; run without -short")
	}
	const size = int64(4<<30) + 1024
	entries := []Entry{{Name: "huge.mov", Size: size}}
	open := func(_ context.Context, _ int) (io.ReadCloser, error) {
		return io.NopCloser(io.LimitReader(zeroReader{}, size)), nil
	}
	cw := &countingWriter{w: io.Discard}
	if err := Stream(context.Background(), cw, entries, open); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if want := Size(entries); cw.n != want {
		t.Errorf("wrote %d bytes, predicted %d", cw.n, want)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

func BenchmarkStreamThroughput(b *testing.B) {
	const size = 64 << 20
	entries := []Entry{{Name: "bench.bin", Size: size}}
	open := func(_ context.Context, _ int) (io.ReadCloser, error) {
		return io.NopCloser(io.LimitReader(zeroReader{}, size)), nil
	}
	b.SetBytes(size)
	for b.Loop() {
		if err := Stream(context.Background(), io.Discard, entries, open); err != nil {
			b.Fatal(err)
		}
	}
}
