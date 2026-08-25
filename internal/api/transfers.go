package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/slug"
	"github.com/collinesfilms/fret/internal/storage"
)

func (s *Server) handleListTransfers(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfers, err := s.db.ListTransfers(r.Context(), u.ID)
	if err != nil {
		s.log.Error("listing transfers", "error", err)
		fail(w, http.StatusInternalServerError, "could not load your transfers")
		return
	}
	used, err := s.db.StorageUsed(r.Context(), &u.ID)
	if err != nil {
		s.log.Warn("summing storage", "error", err)
	}
	out := make([]transferSummary, 0, len(transfers))
	for i := range transfers {
		out = append(out, summarize(&transfers[i]))
	}
	send(w, http.StatusOK, map[string]any{
		"transfers":   out,
		"storageUsed": used,
	})
}

// transferSummary is one row in the transfers sheet.
type transferSummary struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	SharedSlug  string `json:"sharedSlug"`
	FileCount   int    `json:"fileCount"`
	TotalBytes  int64  `json:"totalBytes"`
	Downloads   int64  `json:"downloads"`
	HasPassword bool   `json:"hasPassword"`
	Expiry      string `json:"expiry"`
	ExpiresAt   *int64 `json:"expiresAt"`
	CreatedAt   int64  `json:"createdAt"`
}

func summarize(t *db.Transfer) transferSummary {
	return transferSummary{
		ID: t.ID, Slug: t.Slug, SharedSlug: t.SharedSlug, FileCount: t.FileCount,
		TotalBytes: t.TotalBytes, Downloads: t.Downloads,
		HasPassword: t.HasPassword, Expiry: t.Expiry,
		ExpiresAt: t.ExpiresAt, CreatedAt: t.CreatedAt,
	}
}

func (s *Server) handleGetTransfer(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	files, err := s.db.FilesFor(r.Context(), transfer.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not load the transfer")
		return
	}
	send(w, http.StatusOK, s.transferPayload(r.Context(), transfer, files))
}

func (s *Server) transferPayload(_ context.Context, t *db.Transfer, files []db.File) transferResponse {
	out := transferResponse{
		ID: t.ID, Slug: t.Slug, SharedSlug: t.SharedSlug, Status: t.Status,
		Expiry: t.Expiry, ExpiresAt: t.ExpiresAt,
		Total: t.TotalBytes, Password: t.HasPassword,
		Downloads: t.Downloads, CreatedAt: t.CreatedAt,
	}
	for _, f := range files {
		out.Files = append(out.Files, fileResponse{
			ID: f.ID, Name: f.Name, Size: f.Size,
			PartSize: f.PartSize, PartCount: storage.PartCount(f.Size, f.PartSize),
			Status: f.Status,
		})
	}
	return out
}

type updateTransferRequest struct {
	Slug *string `json:"slug"`
	// Password is three-valued: absent leaves it alone, "" clears protection,
	// any other value sets a new one. A stored password is never sent back, so
	// this is the only way it changes.
	Password *string `json:"password"`
	Expiry   *string `json:"expiry"`
}

func (s *Server) handleUpdateTransfer(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	var req updateTransferRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	newSlug := transfer.Slug
	if req.Slug != nil {
		candidate := slug.Normalize(*req.Slug)
		if err := slug.Validate(candidate); err != nil {
			failCode(w, http.StatusBadRequest, "slug_invalid", err.Error())
			return
		}
		if candidate != transfer.Slug {
			taken, err := s.db.SlugExists(r.Context(), candidate, transfer.ID)
			if err != nil {
				fail(w, http.StatusInternalServerError, "could not check that link")
				return
			}
			if taken {
				failCode(w, http.StatusConflict, "slug_taken", "that link is already in use")
				return
			}
		}
		newSlug = candidate
	}

	hash := transfer.PasswordHash
	if req.Password != nil {
		var err error
		if hash, err = auth.HashPassword(*req.Password); err != nil {
			s.log.Error("hashing password", "error", err)
			fail(w, http.StatusInternalServerError, "could not set that password")
			return
		}
	}

	expiry, expiresAt := transfer.Expiry, transfer.ExpiresAt
	if req.Expiry != nil {
		if !validExpiry(*req.Expiry) {
			fail(w, http.StatusBadRequest, "expiry must be 24h, 7d, 30d or never")
			return
		}
		expiry = *req.Expiry
		// The window is measured from when the transfer was created, so
		// re-picking the same value does not silently extend it.
		expiresAt = expiryTimestamp(expiry, unixTime(transfer.CreatedAt))
	}

	if err := s.db.UpdateTransferSettings(r.Context(), transfer.ID, newSlug, hash, expiry, expiresAt); err != nil {
		if errors.Is(err, db.ErrSlugTaken) {
			failCode(w, http.StatusConflict, "slug_taken", "that link is already in use")
			return
		}
		s.log.Error("updating transfer", "error", err)
		fail(w, http.StatusInternalServerError, "could not save those settings")
		return
	}

	fresh, err := s.db.TransferByID(r.Context(), transfer.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not save those settings")
		return
	}
	files, _ := s.db.FilesFor(r.Context(), transfer.ID)
	send(w, http.StatusOK, s.transferPayload(r.Context(), fresh, files))
}

// handleDeleteTransfer removes a transfer and the objects behind it. An
// in-flight upload has its multipart uploads aborted so no storage is stranded.
func (s *Server) handleDeleteTransfer(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	if err := s.purge(r.Context(), transfer); err != nil {
		s.log.Error("deleting transfer", "error", err, "transfer", transfer.ID)
		fail(w, http.StatusInternalServerError, "could not delete that transfer")
		return
	}
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

// purge removes a transfer from storage and from the database. Storage is
// cleared first: a row that outlives its objects is recoverable, whereas
// objects that outlive their row are invisible and leak.
func (s *Server) purge(ctx context.Context, t *db.Transfer) error {
	files, err := s.db.FilesFor(ctx, t.ID)
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
	return s.db.DeleteTransfer(ctx, t.ID)
}

// handleMarkShared records the name the link was first copied under.
//
// Copying happens in the browser, so the client reports it. Writing it once is
// what lets a rename be undone: the old name stays reserved to this transfer
// and nothing else can claim it.
func (s *Server) handleMarkShared(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	if err := s.db.MarkShared(r.Context(), transfer.ID); err != nil {
		s.log.Error("marking transfer shared", "error", err)
		fail(w, http.StatusInternalServerError, "could not record that")
		return
	}
	fresh, err := s.db.TransferByID(r.Context(), transfer.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not record that")
		return
	}
	files, _ := s.db.FilesFor(r.Context(), transfer.ID)
	send(w, http.StatusOK, s.transferPayload(r.Context(), fresh, files))
}

func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request, u *db.User) {
	if !s.isSuperadmin(u) {
		// Superadmin is decided here, from an environment variable, never from
		// anything the client sends.
		fail(w, http.StatusForbidden, "not permitted")
		return
	}
	bucketBytes, objects, err := s.usage.get(r.Context(), s.store)
	if err != nil {
		s.log.Warn("reading bucket usage", "error", err)
	}
	accounts, err := s.db.CountUsers(r.Context())
	if err != nil {
		s.log.Warn("counting accounts", "error", err)
	}
	tracked, err := s.db.StorageUsed(r.Context(), nil)
	if err != nil {
		s.log.Warn("summing tracked storage", "error", err)
	}
	send(w, http.StatusOK, map[string]any{
		"bucketBytes":   bucketBytes,
		"bucketObjects": objects,
		"trackedBytes":  tracked,
		"accounts":      accounts,
		"region":        s.cfg.S3Region,
		"bucket":        s.cfg.S3Bucket,
	})
}
