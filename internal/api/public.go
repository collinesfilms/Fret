package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/zipstream"
)

// unlockTTL is how long a correct password keeps a recipient in.
const unlockTTL = 4 * time.Hour

// publicTransfer is what a recipient sees. It deliberately carries no sender
// email, no transfer id, and no object keys.
type publicTransfer struct {
	Slug       string       `json:"slug"`
	SenderName string       `json:"senderName"`
	TotalBytes int64        `json:"totalBytes"`
	ExpiresAt  *int64       `json:"expiresAt"`
	Files      []publicFile `json:"files"`
	Locked     bool         `json:"locked"`
	FileCount  int          `json:"fileCount"`
}

type publicFile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// handlePublicTransfer serves the recipient page's data.
//
// A password-protected transfer reveals nothing but the fact that it exists
// and needs a password — not the filenames, not the size, not the sender.
// Seeing what someone sent is part of what the password protects.
func (s *Server) handlePublicTransfer(w http.ResponseWriter, r *http.Request) {
	transfer, ok := s.liveTransfer(w, r)
	if !ok {
		return
	}
	if transfer.HasPassword && !s.unlocked(r, transfer.ID) {
		send(w, http.StatusOK, publicTransfer{Slug: transfer.Slug, Locked: true})
		return
	}
	send(w, http.StatusOK, s.publicPayload(r.Context(), transfer))
}

func (s *Server) publicPayload(ctx context.Context, t *db.Transfer) publicTransfer {
	files, _ := s.db.FilesFor(ctx, t.ID)
	out := publicTransfer{
		Slug: t.Slug, TotalBytes: t.TotalBytes, ExpiresAt: t.ExpiresAt,
		FileCount: len(files),
	}
	if sender, err := s.db.UserByID(ctx, t.UserID); err == nil {
		out.SenderName = sender.Name
	}
	for _, f := range files {
		out.Files = append(out.Files, publicFile{ID: f.ID, Name: f.Name, Size: f.Size})
	}
	return out
}

type unlockRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	transfer, ok := s.liveTransfer(w, r)
	if !ok {
		return
	}
	// Throttle per client and transfer: an unguessable slug is not a reason to
	// leave the password itself brute-forceable.
	if !s.unlocks.allow(clientIP(r) + "|" + transfer.ID) {
		fail(w, http.StatusTooManyRequests, "too many attempts, try again later")
		return
	}
	var req unlockRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if !transfer.HasPassword {
		send(w, http.StatusOK, s.publicPayload(r.Context(), transfer))
		return
	}
	if !auth.VerifyPassword(transfer.PasswordHash, req.Password) {
		fail(w, http.StatusUnauthorized, "that password is not right")
		return
	}

	token, err := auth.Token()
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not unlock the transfer")
		return
	}
	if err := s.db.CreateUnlock(r.Context(), token, transfer.ID, unlockTTL); err != nil {
		s.log.Error("recording unlock", "error", err)
		fail(w, http.StatusInternalServerError, "could not unlock the transfer")
		return
	}
	// The cookie is scoped by transfer id so a recipient can hold grants for
	// several transfers at once without them overwriting each other.
	http.SetCookie(w, &http.Cookie{
		Name:     unlockCookie(transfer.ID),
		Value:    token,
		Path:     "/",
		MaxAge:   int(unlockTTL.Seconds()),
		HttpOnly: true,
		Secure:   strings.HasPrefix(s.cfg.PublicURL, "https://"),
		SameSite: http.SameSiteLaxMode,
	})
	send(w, http.StatusOK, s.publicPayload(r.Context(), transfer))
}

// handlePublicFile redirects to a presigned URL. The bytes go browser to
// storage directly; this process only decides whether they may.
func (s *Server) handlePublicFile(w http.ResponseWriter, r *http.Request) {
	transfer, ok := s.liveTransfer(w, r)
	if !ok {
		return
	}
	if !s.authorized(w, r, transfer) {
		return
	}
	file, err := s.db.FileByID(r.Context(), transfer.ID, r.PathValue("fileID"))
	if err != nil {
		fail(w, http.StatusNotFound, "no such file")
		return
	}
	url, err := s.store.PresignDownload(r.Context(), file.ObjectKey, file.Name)
	if err != nil {
		s.log.Error("presigning download", "error", err)
		fail(w, http.StatusBadGateway, "storage did not issue a download link")
		return
	}
	s.db.IncrementDownloads(r.Context(), transfer.ID)
	// No-store matters: the redirect target is short-lived and single-purpose.
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, url, http.StatusFound)
}

// handleArchive streams every file as one zip.
//
// Nothing is buffered and nothing is written to disk. Because entries are
// stored rather than compressed, the exact length is known before the first
// byte, so the response carries a real Content-Length and the recipient's
// browser can show genuine progress.
func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	transfer, ok := s.liveTransfer(w, r)
	if !ok {
		return
	}
	if !s.authorized(w, r, transfer) {
		return
	}
	files, err := s.db.FilesFor(r.Context(), transfer.ID)
	if err != nil || len(files) == 0 {
		fail(w, http.StatusNotFound, "nothing to download")
		return
	}

	entries := make([]zipstream.Entry, len(files))
	created := time.Unix(transfer.CreatedAt, 0)
	for i, f := range files {
		entries[i] = zipstream.Entry{Name: f.Name, Size: f.Size, Modified: created}
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Length", strconv.FormatInt(zipstream.Size(entries), 10))
	w.Header().Set("Content-Disposition", contentDisposition(transfer.Slug+".zip"))
	w.Header().Set("Cache-Control", "no-store")
	// The length is exact, so a range request would be answerable in principle
	// but not without re-reading from S3; say so rather than implying support.
	w.Header().Set("Accept-Ranges", "none")

	s.db.IncrementDownloads(r.Context(), transfer.ID)

	err = zipstream.Stream(r.Context(), w, entries, func(ctx context.Context, i int) (io.ReadCloser, error) {
		return s.store.Open(ctx, files[i].ObjectKey)
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		// The header is already sent, so the only honest signal left is to
		// break the connection: a truncated body must not look complete.
		s.log.Error("archive stream failed", "error", err, "transfer", transfer.ID)
		panic(http.ErrAbortHandler)
	}
}

// ---------- helpers ----------

// liveTransfer resolves a public slug, treating expired transfers as gone.
func (s *Server) liveTransfer(w http.ResponseWriter, r *http.Request) (*db.Transfer, bool) {
	transfer, err := s.db.TransferBySlug(r.Context(), r.PathValue("slug"))
	if err != nil {
		failCode(w, http.StatusNotFound, "not_found", "this link does not exist")
		return nil, false
	}
	if transfer.Expired(time.Now()) {
		// The sweeper will remove it shortly; until then it must not serve.
		failCode(w, http.StatusGone, "expired", "this link has expired")
		return nil, false
	}
	return transfer, true
}

// authorized gates a download behind the transfer's password, if it has one.
func (s *Server) authorized(w http.ResponseWriter, r *http.Request, t *db.Transfer) bool {
	if !t.HasPassword || s.unlocked(r, t.ID) {
		return true
	}
	failCode(w, http.StatusUnauthorized, "locked", "this transfer needs a password")
	return false
}

func (s *Server) unlocked(r *http.Request, transferID string) bool {
	c, err := r.Cookie(unlockCookie(transferID))
	if err != nil || c.Value == "" {
		return false
	}
	return s.db.UnlockValid(r.Context(), c.Value, transferID)
}

func unlockCookie(transferID string) string { return "fret_ul_" + transferID }

// contentDisposition mirrors the storage package's header construction for
// responses this server writes itself.
func contentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 32 || r > 126 || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	if ascii == "" {
		ascii = "download"
	}
	return fmt.Sprintf(`attachment; filename="%s"`, ascii)
}
