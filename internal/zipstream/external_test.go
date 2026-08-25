package zipstream

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestWriteSampleArchive emits a real archive so external tools (unzip,
// Python's zipfile, macOS Archive Utility) can be pointed at it. Set
// FRET_ZIP_SAMPLE to a path to keep the file.
func TestWriteSampleArchive(t *testing.T) {
	out := os.Getenv("FRET_ZIP_SAMPLE")
	if out == "" {
		out = filepath.Join(t.TempDir(), "sample.zip")
	}
	contents := [][]byte{
		bytes.Repeat([]byte("PRORES FRAME DATA "), 60000),
		[]byte("%PDF-1.7 grade notes for the autumn reel\n"),
		bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47}, 4096),
	}
	entries := []Entry{
		{Name: "reel_autumn_v4_prores.mov", Size: int64(len(contents[0])), Modified: time.Now()},
		{Name: "grade notes — final.pdf", Size: int64(len(contents[1])), Modified: time.Now()},
		{Name: "cover_still_4k.png", Size: int64(len(contents[2])), Modified: time.Now()},
	}

	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	predicted := Size(entries)
	err = Stream(context.Background(), f, entries, func(_ context.Context, i int) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(contents[i])), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() != predicted {
		t.Errorf("predicted %d bytes, wrote %d", predicted, st.Size())
	}
	t.Logf("wrote %s (%d bytes, predicted %d)", out, st.Size(), predicted)
}
