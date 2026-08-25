// Command fret runs the Fret file transfer server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/collinesfilms/fret/internal/api"
	"github.com/collinesfilms/fret/internal/config"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/storage"
	"github.com/collinesfilms/fret/internal/sweeper"
)

// version is stamped at build time with -ldflags.
var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fret: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		return fmt.Errorf("creating data directory %s: %w", cfg.DataDir, err)
	}
	database, err := db.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer database.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := storage.New(ctx, storage.Options{
		PublicEndpoint:   cfg.PresignEndpoint(),
		InternalEndpoint: cfg.ServerEndpoint(),
		Region:           cfg.S3Region,
		Bucket:           cfg.S3Bucket,
		AccessKey:        cfg.S3AccessKey,
		SecretKey:        cfg.S3SecretKey,
		ForcePathStyle:   cfg.S3ForcePath,
		UploadTTL:        cfg.PresignUpload,
		DownloadTTL:      cfg.PresignDownload,
	})
	if err != nil {
		return err
	}
	// A misconfigured bucket should be obvious at boot, not at first upload.
	verifyCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err = store.Verify(verifyCtx)
	cancel()
	if err != nil {
		log.Warn("storage is not reachable yet; uploads will fail until it is", "error", err)
	}

	server := api.New(cfg, database, store, log)
	server.Warm(ctx)

	sweep := sweeper.New(database, store, log, cfg.SweepInterval, cfg.OrphanMaxAge)
	go sweep.Run(ctx)

	httpServer := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: server.Handler(),
		// Uploads go straight to storage, so this process only ever handles
		// small requests and long download streams. A write timeout would cut
		// a large archive off mid-transfer, so there deliberately is none.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Error("shutdown", "error", err)
		}
	}()

	log.Info("fret is listening",
		"version", version,
		"addr", cfg.ListenAddr,
		"app", cfg.AppName,
		"public", cfg.PublicURL,
		"bucket", cfg.S3Bucket,
		"storage", cfg.ServerEndpoint(),
	)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
