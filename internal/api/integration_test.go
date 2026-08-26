package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/config"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/storage"
)

// harness wires a Fret server to an in-process S3, so the upload and download
// paths are exercised end to end rather than mocked.
type harness struct {
	t *testing.T
	// The live config the server is reading. Held by pointer, so a test that
	// needs a differently-configured instance can say so without standing up
	// a second harness.
	cfg     *config.Config
	server  *httptest.Server
	s3      *httptest.Server
	db      *db.DB
	user    *db.User
	session string
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	fake := gofakes3.New(s3mem.New())
	s3srv := httptest.NewServer(fake.Server())
	t.Cleanup(s3srv.Close)

	database, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })

	cfg := &config.Config{
		AppName: "Fret", PublicURL: "http://fret.test", Locale: "en",
		S3Public: s3srv.URL, S3Internal: s3srv.URL,
		S3Region: "us-east-1", S3Bucket: "fret", S3AccessKey: "key", S3SecretKey: "secret",
		S3ForcePath:   true,
		PresignUpload: time.Hour, PresignDownload: 15 * time.Minute,
		OIDCIssuer: "http://oidc.test", OIDCClientID: "fret",
		SessionTTL: time.Hour, SessionSecret: []byte(strings.Repeat("x", 32)),
		Superadmin: "admin@collines.co", ZipConcurrency: 2,
	}

	store, err := storage.New(context.Background(), storage.Options{
		PublicEndpoint: cfg.S3Public, InternalEndpoint: cfg.S3Internal,
		Region: cfg.S3Region, Bucket: cfg.S3Bucket,
		AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
		ForcePathStyle: true, UploadTTL: cfg.PresignUpload, DownloadTTL: cfg.PresignDownload,
	})
	if err != nil {
		t.Fatal(err)
	}
	createBucket(t, s3srv.URL, cfg.S3Bucket)

	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(cfg, database, store, quiet).Handler())
	t.Cleanup(srv.Close)

	// Sign in directly. The OIDC handshake is the provider's concern and has
	// its own tests; everything after it is what this harness exercises.
	user, err := database.UpsertUser(context.Background(), "sub-1", "julien@collines.co", "Julien Marchand")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := auth.Token()
	if err := database.CreateSession(context.Background(), token, user.ID, time.Hour); err != nil {
		t.Fatal(err)
	}

	return &harness{t: t, cfg: cfg, server: srv, s3: s3srv, db: database, user: user, session: token}
}

func createBucket(t *testing.T, endpoint, bucket string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, endpoint+"/"+bucket, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("creating bucket: %d %s", resp.StatusCode, body)
	}
}

// do performs an authenticated request against the app.
func (h *harness) do(method, path string, body any) (*http.Response, []byte) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, h.server.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: "fret_session", Value: h.session})
	return h.send(req)
}

// public performs an unauthenticated request, as a recipient would.
func (h *harness) public(method, path string, body any, cookies ...*http.Cookie) (*http.Response, []byte) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, _ := json.Marshal(body)
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, h.server.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	return h.send(req)
}

func (h *harness) send(req *http.Request) (*http.Response, []byte) {
	h.t.Helper()
	client := &http.Client{
		// Redirects to presigned URLs are inspected rather than followed.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       30 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func decodeInto[T any](t *testing.T, data []byte) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("decoding %s: %v", data, err)
	}
	return out
}

type transferJSON struct {
	ID     string `json:"id"`
	Slug   string `json:"slug"`
	Status string `json:"status"`
	Expiry string `json:"expiry"`
	Total  int64  `json:"totalBytes"`
	Files  []struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Size      int64  `json:"size"`
		PartSize  int64  `json:"partSize"`
		PartCount int32  `json:"partCount"`
	} `json:"files"`
}

// uploadFile walks one file through the real flow: presign, PUT to S3, record
// each part, then complete.
func (h *harness) uploadFile(transferID string, file struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	PartSize  int64  `json:"partSize"`
	PartCount int32  `json:"partCount"`
}, content []byte) {
	h.t.Helper()

	if file.Size == 0 {
		resp, body := h.do(http.MethodPost, fmt.Sprintf("/api/transfers/%s/files/%s/complete", transferID, file.ID), nil)
		if resp.StatusCode != http.StatusOK {
			h.t.Fatalf("completing empty file: %d %s", resp.StatusCode, body)
		}
		return
	}

	parts := make([]int32, 0, file.PartCount)
	for n := int32(1); n <= file.PartCount; n++ {
		parts = append(parts, n)
	}
	resp, body := h.do(http.MethodPost, "/api/transfers/"+transferID+"/parts",
		map[string]any{"fileId": file.ID, "parts": parts})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("presigning parts: %d %s", resp.StatusCode, body)
	}
	urls := decodeInto[struct {
		URLs map[string]string `json:"urls"`
	}](h.t, body).URLs

	for _, n := range parts {
		start := int64(n-1) * file.PartSize
		end := min(start+file.PartSize, file.Size)
		chunk := content[start:end]

		req, _ := http.NewRequest(http.MethodPut, urls[fmt.Sprint(n)], bytes.NewReader(chunk))
		req.ContentLength = int64(len(chunk))
		put, err := http.DefaultClient.Do(req)
		if err != nil {
			h.t.Fatal(err)
		}
		putBody, _ := io.ReadAll(put.Body)
		put.Body.Close()
		if put.StatusCode != http.StatusOK {
			h.t.Fatalf("uploading part %d: %d %s", n, put.StatusCode, putBody)
		}
		etag := put.Header.Get("ETag")
		if etag == "" {
			h.t.Fatalf("part %d returned no ETag; multipart cannot be assembled without one", n)
		}

		rec, recBody := h.do(http.MethodPost,
			fmt.Sprintf("/api/transfers/%s/files/%s/parts", transferID, file.ID),
			map[string]any{"partNumber": n, "etag": etag, "size": len(chunk)})
		if rec.StatusCode != http.StatusOK {
			h.t.Fatalf("recording part %d: %d %s", n, rec.StatusCode, recBody)
		}
	}

	done, doneBody := h.do(http.MethodPost,
		fmt.Sprintf("/api/transfers/%s/files/%s/complete", transferID, file.ID), nil)
	if done.StatusCode != http.StatusOK {
		h.t.Fatalf("completing file: %d %s", done.StatusCode, doneBody)
	}
}

var _ = url.PathEscape
