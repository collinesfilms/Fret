// Package sweeper reclaims storage in the background.
//
// Three jobs run on a timer:
//
//   - Expired transfers are deleted, objects first, then their rows.
//   - Uploads abandoned mid-flight have their S3 multipart uploads aborted.
//     Without this the parts already sent sit in the bucket forever, invisible
//     to any object listing and billed all the same.
//   - Expired sessions and unlock grants are pruned.
package sweeper

import (
	"context"
	"log/slog"
	"time"

	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/storage"
)

// batchSize bounds one pass, so a large backlog is worked through over several
// runs rather than in one long transaction.
const batchSize = 200

type Sweeper struct {
	db           *db.DB
	store        *storage.Store
	log          *slog.Logger
	interval     time.Duration
	orphanMaxAge time.Duration
}

func New(database *db.DB, store *storage.Store, log *slog.Logger, interval, orphanMaxAge time.Duration) *Sweeper {
	return &Sweeper{
		db: database, store: store, log: log,
		interval: interval, orphanMaxAge: orphanMaxAge,
	}
}

// Run sweeps until the context is cancelled.
func (s *Sweeper) Run(ctx context.Context) {
	// An immediate first pass clears anything that expired while Fret was down.
	s.Once(ctx)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Once(ctx)
		}
	}
}

// Once performs a single sweep.
func (s *Sweeper) Once(ctx context.Context) {
	s.db.PruneExpired(ctx)
	s.sweepExpired(ctx)
	s.sweepOrphans(ctx)
}

func (s *Sweeper) sweepExpired(ctx context.Context) {
	expired, err := s.db.ExpiredTransfers(ctx, time.Now(), batchSize)
	if err != nil {
		s.log.Error("listing expired transfers", "error", err)
		return
	}
	for _, t := range expired {
		if ctx.Err() != nil {
			return
		}
		if err := s.purge(ctx, t.ID); err != nil {
			s.log.Error("deleting expired transfer", "transfer", t.ID, "slug", t.Slug, "error", err)
			continue
		}
		s.log.Info("expired transfer removed", "slug", t.Slug, "bytes", t.TotalBytes)
	}
}

// purge deletes a transfer's objects before its rows. Doing it the other way
// round would strand the objects with nothing left pointing at them.
func (s *Sweeper) purge(ctx context.Context, transferID string) error {
	files, err := s.db.FilesFor(ctx, transferID)
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(files))
	for _, f := range files {
		if f.UploadID != "" {
			if err := s.store.AbortUpload(ctx, f.ObjectKey, f.UploadID); err != nil {
				s.log.Warn("aborting upload during purge", "key", f.ObjectKey, "error", err)
			}
		}
		keys = append(keys, f.ObjectKey)
	}
	if err := s.store.Delete(ctx, keys); err != nil {
		return err
	}
	return s.db.DeleteTransfer(ctx, transferID)
}

// sweepOrphans deals with uploads that stopped and never came back.
//
// Fret's own stale rows go first, so their multipart uploads are aborted with
// the ids it knows. Anything still open in the bucket afterwards belongs to no
// transfer at all and is aborted on age alone.
func (s *Sweeper) sweepOrphans(ctx context.Context) {
	cutoff := time.Now().Add(-s.orphanMaxAge)

	stale, err := s.db.StaleTransfers(ctx, cutoff, batchSize)
	if err != nil {
		s.log.Error("listing stale transfers", "error", err)
	}
	for _, t := range stale {
		if ctx.Err() != nil {
			return
		}
		if err := s.purge(ctx, t.ID); err != nil {
			s.log.Error("discarding abandoned upload", "transfer", t.ID, "error", err)
			continue
		}
		s.log.Info("abandoned upload discarded", "slug", t.Slug, "age", time.Since(time.Unix(t.UpdatedAt, 0)).Round(time.Minute))
	}

	orphans, err := s.store.ListOrphans(ctx, cutoff)
	if err != nil {
		s.log.Error("listing multipart uploads", "error", err)
		return
	}
	for _, o := range orphans {
		if ctx.Err() != nil {
			return
		}
		if err := s.store.AbortUpload(ctx, o.Key, o.UploadID); err != nil {
			s.log.Warn("aborting orphaned upload", "key", o.Key, "error", err)
			continue
		}
		s.log.Info("orphaned multipart upload aborted", "key", o.Key, "started", o.Initiated.Format(time.RFC3339))
	}
}
