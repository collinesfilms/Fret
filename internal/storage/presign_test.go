package storage

import (
	"context"
	"net/url"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	store, err := New(context.Background(), Options{
		PublicEndpoint: "https://s3.example.com",
		Region:         "us-east-1",
		Bucket:         "fret",
		AccessKey:      "key",
		SecretKey:      "secret",
		ForcePathStyle: true,
		UploadTTL:      time.Hour,
		DownloadTTL:    15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// TestPresignedUrlsSignOnlyHost is the guard on a failure that is invisible
// until someone deploys.
//
// Fret's presigned URLs are handed to browsers, never to an SDK. A browser
// sends ordinary browser headers and nothing else, so host is the only header
// a presigned URL may sign. Sign anything more — the SDK adds
// x-amz-checksum-mode to GetObject unless told not to — and every S3
// implementation that verifies each signed header is actually present will
// refuse the request, with an error that reads as though the *request* were at
// fault rather than the URL.
//
// Uploads happen to sign only host already, which is exactly what makes this
// worth asserting: the two paths diverged silently once and would have again.
func TestPresignedUrlsSignOnlyHost(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	download, err := store.PresignDownload(ctx, "transfers/a/b/REC00002.wav")
	if err != nil {
		t.Fatal(err)
	}
	upload, err := store.PresignPart(ctx, "transfers/a/b/REC00002.wav", "upload-id", 1)
	if err != nil {
		t.Fatal(err)
	}

	for label, raw := range map[string]string{"download": download, "upload part": upload} {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		signed := parsed.Query().Get("X-Amz-SignedHeaders")
		if signed != "host" {
			t.Errorf(
				"%s presigns X-Amz-SignedHeaders=%q; a browser sends none of those but host, "+
					"so storage will reject the request",
				label, signed,
			)
		}
		if parsed.Query().Get("X-Amz-Signature") == "" {
			t.Errorf("%s is not signed at all", label)
		}
	}
}

// A presigned URL must also carry no response-* overrides: they are signed, so
// every character has to be percent-encoded identically by the SDK, by any
// proxy in front of the bucket and by the backend. The object carries its own
// filename instead.
func TestPresignedDownloadCarriesNoOverrides(t *testing.T) {
	parsed, err := url.Parse(mustPresign(t))
	if err != nil {
		t.Fatal(err)
	}
	for parameter := range parsed.Query() {
		if len(parameter) > 9 && parameter[:9] == "response-" {
			t.Errorf("presigned download carries %q", parameter)
		}
	}
}

func mustPresign(t *testing.T) string {
	t.Helper()
	raw, err := testStore(t).PresignDownload(context.Background(), "transfers/a/b/file.wav")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
