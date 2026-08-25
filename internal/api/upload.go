package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/db"
	"github.com/collinesfilms/fret/internal/slug"
	"github.com/collinesfilms/fret/internal/storage"
)

// maxFilesPerTransfer bounds a single drop. There is no size cap anywhere in
// Fret; this exists only to keep one request from creating unbounded work.
const maxFilesPerTransfer = 2000

// slugAttempts is how many times a random slug is redrawn on collision before
// giving up. With ~40 bits of entropy a single retry is already unlikely.
const slugAttempts = 6

type createTransferRequest struct {
	Files []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
		Type string `json:"type"`
	} `json:"files"`
}

type transferResponse struct {
	ID        string           `json:"id"`
	Slug      string           `json:"slug"`
	Status    string           `json:"status"`
	Expiry    string           `json:"expiry"`
	ExpiresAt *int64           `json:"expiresAt"`
	Total     int64            `json:"totalBytes"`
	Files     []fileResponse   `json:"files"`
	Password  bool             `json:"hasPassword"`
	Downloads int64            `json:"downloads"`
	CreatedAt int64            `json:"createdAt"`
	Uploaded  map[string]int64 `json:"uploadedBytes,omitempty"`
}

type fileResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	PartSize  int64  `json:"partSize"`
	PartCount int32  `json:"partCount"`
	Status    string `json:"status"`
}

// handleCreateTransfer opens a transfer and its multipart uploads.
//
// The slug is minted here, before a single byte moves, so the sender can edit
// it while the upload runs. It is reserved but inert: TransferBySlug only
// resolves transfers in the 'live' state, which this one reaches at finalize.
func (s *Server) handleCreateTransfer(w http.ResponseWriter, r *http.Request, u *db.User) {
	var req createTransferRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Files) == 0 {
		fail(w, http.StatusBadRequest, "no files in this transfer")
		return
	}
	if len(req.Files) > maxFilesPerTransfer {
		fail(w, http.StatusBadRequest, fmt.Sprintf("a transfer holds at most %d files", maxFilesPerTransfer))
		return
	}

	id, err := shortID()
	if err != nil {
		s.log.Error("transfer id", "error", err)
		fail(w, http.StatusInternalServerError, "could not start the transfer")
		return
	}

	// Folder drops are flattened, so two files can arrive with the same name.
	names := make([]string, len(req.Files))
	for i, f := range req.Files {
		names[i] = f.Name
	}
	names = uniqueNames(names)

	now := time.Now()
	expiresAt := expiryTimestamp(u.DefaultExpiry, now)

	var total int64
	files := make([]db.File, len(req.Files))
	created := make([]fileResponse, len(req.Files))
	for i, f := range req.Files {
		if f.Size < 0 {
			fail(w, http.StatusBadRequest, "a file reports a negative size")
			return
		}
		fileID, err := shortID()
		if err != nil {
			s.log.Error("file id", "error", err)
			fail(w, http.StatusInternalServerError, "could not start the transfer")
			return
		}
		key := objectKey(id, fileID, names[i])
		partSize := storage.PartSizeFor(f.Size)

		uploadID := ""
		if f.Size > 0 {
			// Empty files cannot be expressed as a multipart upload; they are
			// written directly at completion instead.
			uploadID, err = s.store.StartUpload(r.Context(), key, names[i], f.Type)
			if err != nil {
				s.log.Error("starting multipart upload", "error", err, "file", names[i])
				s.abortCreated(r.Context(), files[:i])
				fail(w, http.StatusBadGateway, "storage did not accept the upload")
				return
			}
		}

		files[i] = db.File{
			ID: fileID, Name: names[i], Size: f.Size,
			ObjectKey: key, UploadID: uploadID, PartSize: partSize,
		}
		created[i] = fileResponse{
			ID: fileID, Name: names[i], Size: f.Size,
			PartSize: partSize, PartCount: storage.PartCount(f.Size, partSize),
			Status: "pending",
		}
		total += f.Size
	}

	transfer := &db.Transfer{
		ID: id, UserID: u.ID, TotalBytes: total,
		Expiry: u.DefaultExpiry, ExpiresAt: expiresAt,
		CreatedAt: now.Unix(),
	}

	// Redraw on the rare collision rather than failing the upload.
	var createErr error
	for range slugAttempts {
		candidate, err := slug.Generate(u.SlugStyle, u.SlugLength)
		if err != nil {
			s.log.Error("generating slug", "error", err)
			s.abortCreated(r.Context(), files)
			fail(w, http.StatusInternalServerError, "could not start the transfer")
			return
		}
		transfer.Slug = candidate
		createErr = s.db.CreateTransfer(r.Context(), transfer, files)
		if !errors.Is(createErr, db.ErrSlugTaken) {
			break
		}
	}
	if createErr != nil {
		s.log.Error("creating transfer", "error", createErr)
		s.abortCreated(r.Context(), files)
		fail(w, http.StatusInternalServerError, "could not start the transfer")
		return
	}

	send(w, http.StatusCreated, transferResponse{
		ID: id, Slug: transfer.Slug, Status: "pending",
		Expiry: transfer.Expiry, ExpiresAt: expiresAt,
		Total: total, Files: created, CreatedAt: transfer.CreatedAt,
	})
}

// abortCreated releases multipart uploads opened before a later step failed,
// so a rejected transfer leaves nothing behind in the bucket.
func (s *Server) abortCreated(ctx context.Context, files []db.File) {
	for _, f := range files {
		if f.UploadID == "" {
			continue
		}
		if err := s.store.AbortUpload(ctx, f.ObjectKey, f.UploadID); err != nil {
			s.log.Warn("abandoned upload could not be aborted", "key", f.ObjectKey, "error", err)
		}
	}
}

type presignRequest struct {
	FileID string  `json:"fileId"`
	Parts  []int32 `json:"parts"`
}

type presignResponse struct {
	URLs map[string]string `json:"urls"`
}

// maxPresignBatch bounds one round trip. The client asks for the next window
// of parts as it goes rather than for thousands of URLs up front.
const maxPresignBatch = 100

// handlePresignParts hands the browser URLs it PUTs parts to directly. The
// bytes never pass through this process, which is what makes a 100 GB upload
// run at the storage's own speed.
func (s *Server) handlePresignParts(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	var req presignRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Parts) == 0 || len(req.Parts) > maxPresignBatch {
		fail(w, http.StatusBadRequest, fmt.Sprintf("ask for between 1 and %d parts", maxPresignBatch))
		return
	}
	file, err := s.db.FileByID(r.Context(), transfer.ID, req.FileID)
	if err != nil {
		fail(w, http.StatusNotFound, "no such file in this transfer")
		return
	}
	if file.UploadID == "" {
		fail(w, http.StatusConflict, "this file is already complete")
		return
	}

	total := storage.PartCount(file.Size, file.PartSize)
	urls := make(map[string]string, len(req.Parts))
	for _, n := range req.Parts {
		if n < 1 || n > total {
			fail(w, http.StatusBadRequest, fmt.Sprintf("part %d is outside this file", n))
			return
		}
		url, err := s.store.PresignPart(r.Context(), file.ObjectKey, file.UploadID, n)
		if err != nil {
			s.log.Error("presigning part", "error", err)
			fail(w, http.StatusBadGateway, "storage did not issue an upload URL")
			return
		}
		urls[strconv.Itoa(int(n))] = url
	}
	s.db.Touch(r.Context(), transfer.ID)
	send(w, http.StatusOK, presignResponse{URLs: urls})
}

type recordPartRequest struct {
	PartNumber int32  `json:"partNumber"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size"`
}

// handleRecordPart notes a part that landed. This is the entire resume story:
// what is recorded here is what a returning browser can skip.
func (s *Server) handleRecordPart(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	var req recordPartRequest
	if err := decode(w, r, &req); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	file, err := s.db.FileByID(r.Context(), transfer.ID, r.PathValue("fileID"))
	if err != nil {
		fail(w, http.StatusNotFound, "no such file in this transfer")
		return
	}
	if req.PartNumber < 1 || req.ETag == "" {
		fail(w, http.StatusBadRequest, "a part needs a number and an etag")
		return
	}
	if err := s.db.RecordPart(r.Context(), file.ID, db.Part{
		PartNumber: req.PartNumber,
		ETag:       strings.Trim(req.ETag, `"`),
		Size:       req.Size,
	}); err != nil {
		s.log.Error("recording part", "error", err)
		fail(w, http.StatusInternalServerError, "could not record that part")
		return
	}
	s.db.Touch(r.Context(), transfer.ID)
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleCompleteFile assembles one file's parts into its final object.
func (s *Server) handleCompleteFile(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	file, err := s.db.FileByID(r.Context(), transfer.ID, r.PathValue("fileID"))
	if err != nil {
		fail(w, http.StatusNotFound, "no such file in this transfer")
		return
	}
	if file.Status == "complete" {
		send(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	if file.Size == 0 {
		if err := s.store.PutEmpty(r.Context(), file.ObjectKey, file.Name); err != nil {
			s.log.Error("writing empty object", "error", err)
			fail(w, http.StatusBadGateway, "storage rejected the file")
			return
		}
	} else {
		parts, err := s.db.PartsFor(r.Context(), file.ID)
		if err != nil {
			s.log.Error("reading parts", "error", err)
			fail(w, http.StatusInternalServerError, "could not complete the file")
			return
		}
		want := storage.PartCount(file.Size, file.PartSize)
		if int32(len(parts)) != want {
			failCode(w, http.StatusConflict, "incomplete",
				fmt.Sprintf("%d of %d parts have arrived", len(parts), want))
			return
		}
		completed := make([]storage.CompletedPart, len(parts))
		for i, p := range parts {
			completed[i] = storage.CompletedPart{PartNumber: p.PartNumber, ETag: p.ETag}
		}
		if err := s.store.FinishUpload(r.Context(), file.ObjectKey, file.UploadID, completed); err != nil {
			s.log.Error("completing multipart upload", "error", err, "file", file.Name)
			fail(w, http.StatusBadGateway, "storage could not assemble the file")
			return
		}
	}

	if err := s.db.MarkFileComplete(r.Context(), file.ID, nil); err != nil {
		s.log.Error("marking file complete", "error", err)
		fail(w, http.StatusInternalServerError, "could not complete the file")
		return
	}
	s.db.Touch(r.Context(), transfer.ID)
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleFinalize flips the transfer live. This is the instant its slug starts
// resolving, and the instant the link becomes worth copying.
func (s *Server) handleFinalize(w http.ResponseWriter, r *http.Request, u *db.User) {
	transfer, ok := s.ownedTransfer(w, r, u)
	if !ok {
		return
	}
	files, err := s.db.FilesFor(r.Context(), transfer.ID)
	if err != nil {
		s.log.Error("reading files", "error", err)
		fail(w, http.StatusInternalServerError, "could not finish the transfer")
		return
	}
	var total int64
	for _, f := range files {
		if f.Status != "complete" {
			failCode(w, http.StatusConflict, "incomplete", "not every file has finished uploading")
			return
		}
		total += f.Size
	}
	if err := s.db.FinalizeTransfer(r.Context(), transfer.ID, total); err != nil {
		s.log.Error("finalizing transfer", "error", err)
		fail(w, http.StatusInternalServerError, "could not finish the transfer")
		return
	}
	fresh, err := s.db.TransferByID(r.Context(), transfer.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not finish the transfer")
		return
	}
	send(w, http.StatusOK, s.transferPayload(r.Context(), fresh, files))
}

// resumableTransfer describes an upload that stopped partway, with enough
// detail for the client to match it against files the user re-selects.
type resumableTransfer struct {
	ID        string          `json:"id"`
	Slug      string          `json:"slug"`
	CreatedAt int64           `json:"createdAt"`
	Total     int64           `json:"totalBytes"`
	Uploaded  int64           `json:"uploadedBytes"`
	Files     []resumableFile `json:"files"`
}

type resumableFile struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	PartSize  int64   `json:"partSize"`
	PartCount int32   `json:"partCount"`
	Status    string  `json:"status"`
	HavePart  []int32 `json:"havePart"`
}

// handleResumable lists uploads that never finished.
//
// A page reload destroys the browser's File handles, so Fret cannot reach back
// into the filesystem on its own. What it can do is remember exactly which
// parts arrived: the user re-selects the same files and only the gaps are sent.
func (s *Server) handleResumable(w http.ResponseWriter, r *http.Request, u *db.User) {
	pending, err := s.db.PendingTransfers(r.Context(), u.ID)
	if err != nil {
		s.log.Error("listing pending transfers", "error", err)
		fail(w, http.StatusInternalServerError, "could not check for unfinished uploads")
		return
	}
	out := make([]resumableTransfer, 0, len(pending))
	for _, t := range pending {
		files, err := s.db.FilesFor(r.Context(), t.ID)
		if err != nil {
			continue
		}
		entry := resumableTransfer{ID: t.ID, Slug: t.Slug, CreatedAt: t.CreatedAt, Total: t.TotalBytes}
		for _, f := range files {
			parts, _ := s.db.PartsFor(r.Context(), f.ID)
			have := make([]int32, 0, len(parts))
			for _, p := range parts {
				have = append(have, p.PartNumber)
			}
			// A finished file counts in full; an unfinished one counts only
			// the parts that actually landed.
			if f.Status == "complete" {
				entry.Uploaded += f.Size
			} else {
				entry.Uploaded += sumSizes(parts)
			}
			entry.Files = append(entry.Files, resumableFile{
				ID: f.ID, Name: f.Name, Size: f.Size,
				PartSize: f.PartSize, PartCount: storage.PartCount(f.Size, f.PartSize),
				Status: f.Status, HavePart: have,
			})
		}
		out = append(out, entry)
	}
	send(w, http.StatusOK, map[string]any{"transfers": out})
}

func sumSizes(parts []db.Part) int64 {
	var n int64
	for _, p := range parts {
		n += p.Size
	}
	return n
}

// ---------- shared helpers ----------

// ownedTransfer loads the transfer named in the path and confirms it belongs
// to the caller.
func (s *Server) ownedTransfer(w http.ResponseWriter, r *http.Request, u *db.User) (*db.Transfer, bool) {
	transfer, err := s.db.TransferByID(r.Context(), r.PathValue("id"))
	if err != nil || transfer.UserID != u.ID {
		// Not distinguishing "missing" from "someone else's" keeps the API
		// from confirming that an id exists.
		fail(w, http.StatusNotFound, "no such transfer")
		return nil, false
	}
	return transfer, true
}

// objectKey lays out the bucket as transfers/<transfer>/<file>/<name>, which
// keeps a prefix per transfer for easy inspection and deletion.
func objectKey(transferID, fileID, name string) string {
	clean := path.Base(strings.ReplaceAll(name, "\\", "/"))
	clean = strings.Map(func(r rune) rune {
		if r < 32 || r == 0x7f {
			return -1
		}
		return r
	}, clean)
	if clean == "" || clean == "." || clean == ".." {
		clean = "file"
	}
	return fmt.Sprintf("transfers/%s/%s/%s", transferID, fileID, clean)
}

// uniqueNames flattens a drop into distinct display names, appending a counter
// the way a desktop file manager does.
func uniqueNames(names []string) []string {
	seen := make(map[string]int, len(names))
	out := make([]string, len(names))
	for i, raw := range names {
		name := path.Base(strings.ReplaceAll(raw, "\\", "/"))
		name = strings.TrimSpace(name)
		if name == "" || name == "." || name == ".." {
			name = "file"
		}
		key := strings.ToLower(name)
		if n, clash := seen[key]; clash {
			ext := path.Ext(name)
			stem := strings.TrimSuffix(name, ext)
			for {
				n++
				candidate := fmt.Sprintf("%s (%d)%s", stem, n, ext)
				if _, taken := seen[strings.ToLower(candidate)]; !taken {
					seen[key] = n
					name = candidate
					key = strings.ToLower(candidate)
					break
				}
			}
		}
		seen[key] = 0
		out[i] = name
	}
	return out
}

// shortID mints an opaque internal identifier.
func shortID() (string, error) {
	token, err := auth.Token()
	if err != nil {
		return "", err
	}
	return token[:16], nil
}

// expiryTimestamp turns a symbolic expiry into an absolute time.
func expiryTimestamp(symbol string, from time.Time) *int64 {
	var d time.Duration
	switch symbol {
	case "24h":
		d = 24 * time.Hour
	case "7d":
		d = 7 * 24 * time.Hour
	case "30d":
		d = 30 * 24 * time.Hour
	default:
		return nil // never
	}
	ts := from.Add(d).Unix()
	return &ts
}

func validExpiry(symbol string) bool {
	switch symbol {
	case "24h", "7d", "30d", "never":
		return true
	}
	return false
}

// unixTime converts a stored timestamp back to a time.Time.
func unixTime(sec int64) time.Time { return time.Unix(sec, 0) }
