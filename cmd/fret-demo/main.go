// Command fret-demo runs Fret against an in-process, in-memory S3 with a
// pre-signed-in account and some seeded transfers.
//
// It exists so anyone can see the interface without standing up storage or an
// identity provider, and so the project's screenshots come from the real
// application rather than a mockup. It skips the OIDC handshake entirely and
// holds everything in memory.
//
// It is a development tool. It is not built into the Docker image, and it must
// never be exposed to a network you do not control.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"

	"github.com/collinesfilms/fret/internal/api"
	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/config"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/storage"
)

const (
	appAddr  = "127.0.0.1:8080"
	demoUser = "Julien Marchand"
	demoMail = "julien@collines.co"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fret-demo: %v\n", err)
		os.Exit(1)
	}
}

// demoLocale lets the demo be started in any language the interface ships, so
// a translation can be looked at in the real application rather than read as a
// table of strings:
//
//	FRET_LOCALE=fr go run ./cmd/fret-demo
func demoLocale() string {
	return config.Locale(os.Getenv("FRET_LOCALE"))
}

func run() error {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))
	ctx := context.Background()

	s3URL, err := startFakeS3()
	if err != nil {
		return err
	}
	if err := createBucket(s3URL, "fret"); err != nil {
		return err
	}

	dir, err := os.MkdirTemp("", "fret-demo-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	database, err := db.Open(dir)
	if err != nil {
		return err
	}
	defer database.Close()

	cfg := &config.Config{
		AppName: "Fret", PublicURL: "http://" + appAddr, Locale: demoLocale(),
		ListenAddr: appAddr,
		S3Public:   s3URL, S3Internal: s3URL,
		S3Region: "eu-west-3", S3Bucket: "fret",
		S3AccessKey: "demo", S3SecretKey: "demo-secret", S3ForcePath: true,
		PresignUpload: time.Hour, PresignDownload: 15 * time.Minute,
		// Illustrative only; the demo never performs the OIDC round trip.
		OIDCIssuer: "https://id.example.com", OIDCClientID: "demo",
		SessionTTL: 24 * time.Hour, SessionSecret: []byte(strings.Repeat("demo-secret-", 4)),
		// The seeded account is the superadmin, so the settings popover shows
		// the bucket-wide block.
		Superadmin: demoMail,
		DataDir:    dir, SweepInterval: time.Hour, OrphanMaxAge: time.Hour,
		ZipConcurrency: 2, Dev: true,
	}

	store, err := storage.New(ctx, storage.Options{
		PublicEndpoint: cfg.S3Public, InternalEndpoint: cfg.S3Internal,
		Region: cfg.S3Region, Bucket: cfg.S3Bucket,
		AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
		ForcePathStyle: true, UploadTTL: cfg.PresignUpload, DownloadTTL: cfg.PresignDownload,
	})
	if err != nil {
		return err
	}

	user, err := database.UpsertUser(ctx, "demo-subject", demoMail, demoUser)
	if err != nil {
		return err
	}
	session, err := auth.Token()
	if err != nil {
		return err
	}
	if err := database.CreateSession(ctx, session, user.ID, 24*time.Hour); err != nil {
		return err
	}

	app := api.New(cfg, database, store, log).Handler()

	mux := http.NewServeMux()
	// Stands in for the OIDC round trip: sets the seeded session, lands on the
	// app.
	mux.HandleFunc("GET /demo-login", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name: "fret_session", Value: session, Path: "/",
			MaxAge: int((24 * time.Hour).Seconds()), HttpOnly: true, SameSite: http.SameSiteLaxMode,
		})
		http.Redirect(w, r, "/", http.StatusFound)
	})
	mux.Handle("/", app)

	server := &http.Server{Addr: appAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "fret-demo: %v\n", err)
			os.Exit(1)
		}
	}()
	if err := waitForServer("http://" + appAddr + "/api/health"); err != nil {
		return err
	}

	if err := seed(session); err != nil {
		return fmt.Errorf("seeding transfers: %w", err)
	}

	fmt.Printf(`
  Fret demo is running.

    Sign in    http://%s/demo-login
    Signed out http://%s/

  In-memory storage and a seeded account. Nothing is persisted.
  Press Ctrl-C to stop.

`, appAddr, appAddr)

	select {}
}

func startFakeS3() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	server := withCORS(gofakes3.New(s3mem.New()).Server())
	go func() { _ = http.Serve(listener, server) }()
	return "http://" + listener.Addr().String(), nil
}

// withCORS makes the fake bucket behave like a correctly configured real one.
//
// Exposing ETag is the part that matters: the browser reads it from each part
// upload, and without it multipart uploads cannot be assembled. It is the most
// common way a real Fret deployment is misconfigured, so the demo has to get
// it right or it would not be exercising the same path.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Access-Control-Allow-Origin", "*")
		header.Set("Access-Control-Allow-Methods", "GET, PUT, POST, HEAD, DELETE")
		header.Set("Access-Control-Allow-Headers", "*")
		header.Set("Access-Control-Expose-Headers", "ETag")
		header.Set("Access-Control-Max-Age", "3000")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func createBucket(endpoint, bucket string) error {
	req, err := http.NewRequest(http.MethodPut, endpoint+"/"+bucket, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("creating bucket: %d %s", resp.StatusCode, body)
	}
	return nil
}

func waitForServer(url string) error {
	for range 100 {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("server did not come up")
}

type seedTransfer struct {
	slug     string
	files    []seedFile
	password string
	expiry   string
}

type seedFile struct {
	name string
	size int
}

// seed builds a plausible history so the transfers sheet has something to show.
func seed(session string) error {
	transfers := []seedTransfer{
		{
			slug: "client-review-oct", expiry: "24h",
			files: []seedFile{
				{"reel_autumn_v4_prores.mov", 900_000}, {"reel_autumn_v4_h264.mp4", 420_000},
				{"cover_still_4k.png", 96_000}, {"grade_notes.pdf", 22_000},
				{"lut_pack_v2.cube", 8_000}, {"audio_stems_mixdown.wav", 310_000},
			},
		},
		{
			slug: "masters-hifi", password: "listen", expiry: "30d",
			files: []seedFile{{"master_01_24bit.wav", 640_000}, {"master_02_24bit.wav", 610_000}},
		},
		{
			slug: "stills-batch-2", expiry: "7d",
			files: []seedFile{
				{"still_0001.tif", 140_000}, {"still_0002.tif", 138_000},
				{"still_0003.tif", 141_000}, {"contact_sheet.pdf", 40_000},
			},
		},
		{
			slug: "bts-selects", expiry: "30d",
			files: []seedFile{{"bts_reel.mov", 480_000}, {"bts_stills.zip", 210_000}},
		},
		{
			slug: "grade-notes-final", password: "colour", expiry: "7d",
			files: []seedFile{{"grade_notes_final.pdf", 34_000}},
		},
	}

	for _, entry := range transfers {
		if err := createSeededTransfer(session, entry); err != nil {
			return err
		}
	}
	return nil
}

// createSeededTransfer walks the real upload flow: create, presign, PUT to
// storage, record each part, complete, finalize, then apply settings.
func createSeededTransfer(session string, entry seedTransfer) error {
	meta := make([]map[string]any, len(entry.files))
	contents := make([][]byte, len(entry.files))
	for i, f := range entry.files {
		contents[i] = filler(f.name, f.size)
		meta[i] = map[string]any{"name": f.name, "size": f.size, "type": "application/octet-stream"}
	}

	var created struct {
		ID    string `json:"id"`
		Files []struct {
			ID        string `json:"id"`
			Size      int64  `json:"size"`
			PartSize  int64  `json:"partSize"`
			PartCount int32  `json:"partCount"`
		} `json:"files"`
	}
	if err := call(session, http.MethodPost, "/api/transfers", map[string]any{"files": meta}, &created); err != nil {
		return err
	}

	for i, file := range created.Files {
		var signed struct {
			URLs map[string]string `json:"urls"`
		}
		parts := make([]int32, 0, file.PartCount)
		for n := int32(1); n <= file.PartCount; n++ {
			parts = append(parts, n)
		}
		if err := call(session, http.MethodPost, "/api/transfers/"+created.ID+"/parts",
			map[string]any{"fileId": file.ID, "parts": parts}, &signed); err != nil {
			return err
		}
		for _, n := range parts {
			start := int64(n-1) * file.PartSize
			end := min(start+file.PartSize, file.Size)
			chunk := contents[i][start:end]

			req, _ := http.NewRequest(http.MethodPut, signed.URLs[fmt.Sprint(n)], bytes.NewReader(chunk))
			req.ContentLength = int64(len(chunk))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			etag := resp.Header.Get("ETag")
			resp.Body.Close()

			if err := call(session, http.MethodPost,
				fmt.Sprintf("/api/transfers/%s/files/%s/parts", created.ID, file.ID),
				map[string]any{"partNumber": n, "etag": etag, "size": len(chunk)}, nil); err != nil {
				return err
			}
		}
		if err := call(session, http.MethodPost,
			fmt.Sprintf("/api/transfers/%s/files/%s/complete", created.ID, file.ID), nil, nil); err != nil {
			return err
		}
	}

	if err := call(session, http.MethodPost, "/api/transfers/"+created.ID+"/finalize", nil, nil); err != nil {
		return err
	}

	patch := map[string]any{"slug": entry.slug, "expiry": entry.expiry}
	if entry.password != "" {
		patch["password"] = entry.password
	}
	if err := call(session, http.MethodPatch, "/api/transfers/"+created.ID, patch, nil); err != nil {
		return err
	}

	// Seeded transfers are history, and history means links that were sent. It
	// has to come after the rename, because the shared name is whatever the
	// slug is at the moment it is recorded — and it is what makes renaming one
	// of these in the edit modal carry a consequence, as it would in life.
	return call(session, http.MethodPost, "/api/transfers/"+created.ID+"/shared", nil, nil)
}

// filler produces deterministic bytes so seeded files are not all identical.
func filler(name string, size int) []byte {
	out := make([]byte, size)
	seed := byte(len(name))
	for i := range out {
		out[i] = seed + byte(i%251)
	}
	return out
}

func call(session, method, path string, body, into any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, "http://"+appAddr+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: "fret_session", Value: session})

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d %s", method, path, resp.StatusCode, data)
	}
	if into != nil {
		return json.Unmarshal(data, into)
	}
	return nil
}
