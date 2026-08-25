package api

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/collinesfilms/fret/internal/auth"
	"github.com/collinesfilms/fret/internal/slug"
)

// sampleFiles mirrors a real drop: a large-ish media file that spans multiple
// parts, a small one, and an empty file, which multipart cannot express.
func sampleFiles() ([]map[string]any, [][]byte, []string) {
	contents := [][]byte{
		bytes.Repeat([]byte("PRORES-FRAME-"), 500_000), // ~6.5 MB
		[]byte("%PDF-1.7 grade notes\n"),
		{},
	}
	names := []string{"reel_autumn_v4.mov", "grade notes.pdf", "empty.txt"}
	meta := make([]map[string]any, len(names))
	for i := range names {
		meta[i] = map[string]any{"name": names[i], "size": len(contents[i]), "type": "application/octet-stream"}
	}
	return meta, contents, names
}

// TestFullTransferJourney walks a transfer from drop to recipient download.
func TestFullTransferJourney(t *testing.T) {
	h := newHarness(t)
	meta, contents, names := sampleFiles()

	resp, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating transfer: %d %s", resp.StatusCode, body)
	}
	transfer := decodeInto[transferJSON](t, body)

	if transfer.Status != "pending" {
		t.Errorf("a new transfer should be pending, got %q", transfer.Status)
	}
	if transfer.Slug == "" {
		t.Fatal("no slug was minted")
	}

	// The slug is reserved from the first byte but must not resolve until the
	// upload lands. That gap is the whole reason copy stays locked.
	if got, _ := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil); got.StatusCode != http.StatusNotFound {
		t.Errorf("a pending transfer's slug resolved with %d; it should not resolve yet", got.StatusCode)
	}

	for i, file := range transfer.Files {
		h.uploadFile(transfer.ID, file, contents[i])
	}

	final, finalBody := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/finalize", nil)
	if final.StatusCode != http.StatusOK {
		t.Fatalf("finalizing: %d %s", final.StatusCode, finalBody)
	}
	if live := decodeInto[transferJSON](t, finalBody); live.Status != "live" {
		t.Errorf("after finalize the transfer should be live, got %q", live.Status)
	}

	// Now it resolves.
	pub, pubBody := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil)
	if pub.StatusCode != http.StatusOK {
		t.Fatalf("recipient view: %d %s", pub.StatusCode, pubBody)
	}
	view := decodeInto[struct {
		SenderName string `json:"senderName"`
		TotalBytes int64  `json:"totalBytes"`
		Locked     bool   `json:"locked"`
		Files      []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Size int64  `json:"size"`
		} `json:"files"`
	}](t, pubBody)

	if view.Locked {
		t.Error("a transfer with no password should not be locked")
	}
	if view.SenderName != "Julien Marchand" {
		t.Errorf("sender name is %q", view.SenderName)
	}
	if len(view.Files) != len(names) {
		t.Fatalf("recipient sees %d files, want %d", len(view.Files), len(names))
	}
	for i, f := range view.Files {
		if f.Name != names[i] {
			t.Errorf("file %d is named %q, want %q", i, f.Name, names[i])
		}
	}

	// A single file redirects straight to storage; the bytes never come
	// through Fret.
	one, _ := h.public(http.MethodGet, fmt.Sprintf("/api/t/%s/files/%s", transfer.Slug, view.Files[0].ID), nil)
	if one.StatusCode != http.StatusFound {
		t.Fatalf("single-file download returned %d, want a redirect", one.StatusCode)
	}
	location := one.Header.Get("Location")
	if !strings.HasPrefix(location, h.s3.URL) {
		t.Errorf("redirect points at %q, which is not the storage endpoint", location)
	}
	fetched := fetch(t, location)
	if !bytes.Equal(fetched, contents[0]) {
		t.Errorf("downloaded %d bytes, expected %d", len(fetched), len(contents[0]))
	}

	// And the archive streams everything as one zip.
	arch, archBody := h.public(http.MethodGet, "/api/t/"+transfer.Slug+"/archive", nil)
	if arch.StatusCode != http.StatusOK {
		t.Fatalf("archive: %d", arch.StatusCode)
	}
	if ct := arch.Header.Get("Content-Type"); ct != "application/zip" {
		t.Errorf("archive content type is %q", ct)
	}

	// The promised length must match what actually arrived, or a recipient's
	// progress bar lies.
	declared, err := strconv.Atoi(arch.Header.Get("Content-Length"))
	if err != nil {
		t.Fatalf("archive sent no usable Content-Length: %v", err)
	}
	if declared != len(archBody) {
		t.Errorf("archive declared %d bytes and sent %d", declared, len(archBody))
	}

	reader, err := zip.NewReader(bytes.NewReader(archBody), int64(len(archBody)))
	if err != nil {
		t.Fatalf("the archive does not parse: %v", err)
	}
	if len(reader.File) != len(names) {
		t.Fatalf("archive holds %d entries, want %d", len(reader.File), len(names))
	}
	for i, entry := range reader.File {
		if entry.Name != names[i] {
			t.Errorf("archive entry %d is %q, want %q", i, entry.Name, names[i])
		}
		rc, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Errorf("entry %q failed its checksum: %v", entry.Name, err)
			continue
		}
		if !bytes.Equal(got, contents[i]) {
			t.Errorf("entry %q: %d bytes, want %d", entry.Name, len(got), len(contents[i]))
		}
	}
}

// TestPasswordProtectionHidesEverything checks that a locked transfer gives
// nothing away before the password is entered.
func TestPasswordProtectionHidesEverything(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)

	set, setBody := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID,
		map[string]any{"password": "the-magic-word"})
	if set.StatusCode != http.StatusOK {
		t.Fatalf("setting a password: %d %s", set.StatusCode, setBody)
	}

	locked, lockedBody := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil)
	if locked.StatusCode != http.StatusOK {
		t.Fatalf("locked view: %d", locked.StatusCode)
	}
	view := decodeInto[struct {
		Locked     bool   `json:"locked"`
		SenderName string `json:"senderName"`
		TotalBytes int64  `json:"totalBytes"`
		Files      []struct {
			Name string `json:"name"`
		} `json:"files"`
	}](t, lockedBody)

	if !view.Locked {
		t.Fatal("the transfer should report as locked")
	}
	// Filenames say a great deal about a delivery; they are part of what the
	// password protects.
	if len(view.Files) != 0 || view.SenderName != "" || view.TotalBytes != 0 {
		t.Errorf("a locked transfer leaked detail: %s", lockedBody)
	}

	// Downloads are refused too, not merely hidden from the page.
	files, _ := h.db.FilesFor(t.Context(), transfer.ID)
	dl, _ := h.public(http.MethodGet, fmt.Sprintf("/api/t/%s/files/%s", transfer.Slug, files[0].ID), nil)
	if dl.StatusCode != http.StatusUnauthorized {
		t.Errorf("a locked file downloaded with status %d", dl.StatusCode)
	}
	arch, _ := h.public(http.MethodGet, "/api/t/"+transfer.Slug+"/archive", nil)
	if arch.StatusCode != http.StatusUnauthorized {
		t.Errorf("a locked archive downloaded with status %d", arch.StatusCode)
	}

	// A wrong password stays out.
	bad, _ := h.public(http.MethodPost, "/api/t/"+transfer.Slug+"/unlock", map[string]any{"password": "guess"})
	if bad.StatusCode != http.StatusUnauthorized {
		t.Errorf("a wrong password returned %d", bad.StatusCode)
	}

	// The right one gets in, and the grant carries to downloads.
	good, goodBody := h.public(http.MethodPost, "/api/t/"+transfer.Slug+"/unlock",
		map[string]any{"password": "the-magic-word"})
	if good.StatusCode != http.StatusOK {
		t.Fatalf("the correct password was refused: %d %s", good.StatusCode, goodBody)
	}
	unlocked := decodeInto[struct {
		Files []struct{ Name string } `json:"files"`
	}](t, goodBody)
	if len(unlocked.Files) == 0 {
		t.Error("unlocking revealed no files")
	}

	var grant *http.Cookie
	for _, c := range good.Cookies() {
		if strings.HasPrefix(c.Name, "fret_ul_") {
			grant = c
		}
	}
	if grant == nil {
		t.Fatal("unlocking issued no grant cookie")
	}
	with, _ := h.public(http.MethodGet, "/api/t/"+transfer.Slug+"/archive", nil, grant)
	if with.StatusCode != http.StatusOK {
		t.Errorf("an unlocked archive returned %d", with.StatusCode)
	}
}

// TestPasswordIsNeverReadableBack confirms a saved password cannot be read out
// of the API by its own owner.
func TestPasswordIsNeverReadableBack(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"password": "secret-value"})

	_, body := h.do(http.MethodGet, "/api/transfers/"+transfer.ID, nil)
	if bytes.Contains(body, []byte("secret-value")) {
		t.Errorf("the stored password came back in the API response: %s", body)
	}
	if !bytes.Contains(body, []byte(`"hasPassword":true`)) {
		t.Errorf("the response should still say a password is set: %s", body)
	}

	// Clearing it is an explicit empty string, never an omission.
	h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"password": ""})
	_, after := h.do(http.MethodGet, "/api/transfers/"+transfer.ID, nil)
	if !bytes.Contains(after, []byte(`"hasPassword":false`)) {
		t.Errorf("clearing the password did not remove protection: %s", after)
	}
}

// TestSlugCollisionIsRejected covers the uniqueness check the original design
// note flagged as missing.
func TestSlugCollisionIsRejected(t *testing.T) {
	h := newHarness(t)
	first := h.completeTransfer(t)
	second := h.completeTransfer(t)

	resp, body := h.do(http.MethodPatch, "/api/transfers/"+second.ID, map[string]any{"slug": first.Slug})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("claiming a taken slug returned %d, want 409: %s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte("slug_taken")) {
		t.Errorf("the response should carry a machine-readable code: %s", body)
	}

	// A free slug is accepted, and the old one stops resolving.
	ok, okBody := h.do(http.MethodPatch, "/api/transfers/"+second.ID, map[string]any{"slug": "client-review-oct"})
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("renaming to a free slug failed: %d %s", ok.StatusCode, okBody)
	}
	if gone, _ := h.public(http.MethodGet, "/api/t/"+second.Slug, nil); gone.StatusCode != http.StatusNotFound {
		t.Errorf("the previous slug still resolves with %d", gone.StatusCode)
	}
	if now, _ := h.public(http.MethodGet, "/api/t/client-review-oct", nil); now.StatusCode != http.StatusOK {
		t.Errorf("the new slug does not resolve: %d", now.StatusCode)
	}
}

func TestReservedSlugsAreRefused(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	for _, reserved := range []string{"api", "auth", "admin", "assets"} {
		resp, _ := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"slug": reserved})
		if resp.StatusCode == http.StatusOK {
			t.Errorf("%q was accepted as a slug and would shadow an application route", reserved)
		}
	}
}

// TestResumeSkipsUploadedParts is the resume path: parts recorded before an
// interruption are reported back so only the gaps are re-sent.
func TestResumeSkipsUploadedParts(t *testing.T) {
	h := newHarness(t)
	content := bytes.Repeat([]byte("A"), 40<<20) // 40 MB, several parts
	meta := []map[string]any{{"name": "big.mov", "size": len(content), "type": ""}}

	_, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	transfer := decodeInto[transferJSON](t, body)
	file := transfer.Files[0]
	if file.PartCount < 2 {
		t.Fatalf("expected a multi-part file, got %d parts", file.PartCount)
	}

	// Upload the first part only, then walk away.
	_, urlBody := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/parts",
		map[string]any{"fileId": file.ID, "parts": []int32{1}})
	urls := decodeInto[struct {
		URLs map[string]string `json:"urls"`
	}](t, urlBody).URLs

	chunk := content[:file.PartSize]
	req, _ := http.NewRequest(http.MethodPut, urls["1"], bytes.NewReader(chunk))
	req.ContentLength = int64(len(chunk))
	put, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	put.Body.Close()
	h.do(http.MethodPost, fmt.Sprintf("/api/transfers/%s/files/%s/parts", transfer.ID, file.ID),
		map[string]any{"partNumber": 1, "etag": put.Header.Get("ETag"), "size": len(chunk)})

	// Coming back, the server reports exactly what already landed.
	resp, resumeBody := h.do(http.MethodGet, "/api/transfers/resumable", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("resumable: %d %s", resp.StatusCode, resumeBody)
	}
	resumable := decodeInto[struct {
		Transfers []struct {
			ID       string `json:"id"`
			Uploaded int64  `json:"uploadedBytes"`
			Total    int64  `json:"totalBytes"`
			Files    []struct {
				HavePart []int32 `json:"havePart"`
			} `json:"files"`
		} `json:"transfers"`
	}](t, resumeBody)

	if len(resumable.Transfers) != 1 {
		t.Fatalf("expected one unfinished transfer, got %d", len(resumable.Transfers))
	}
	got := resumable.Transfers[0]
	if got.ID != transfer.ID {
		t.Errorf("wrong transfer reported as resumable")
	}
	if len(got.Files[0].HavePart) != 1 || got.Files[0].HavePart[0] != 1 {
		t.Errorf("part 1 should be reported as already present, got %v", got.Files[0].HavePart)
	}
	if got.Uploaded != file.PartSize {
		t.Errorf("uploaded bytes reported as %d, want %d", got.Uploaded, file.PartSize)
	}

	// Completing with parts missing must fail rather than assemble a truncated
	// object.
	bad, badBody := h.do(http.MethodPost,
		fmt.Sprintf("/api/transfers/%s/files/%s/complete", transfer.ID, file.ID), nil)
	if bad.StatusCode != http.StatusConflict {
		t.Errorf("completing a half-uploaded file returned %d, want 409: %s", bad.StatusCode, badBody)
	}
}

func TestFinalizeRefusesIncompleteTransfer(t *testing.T) {
	h := newHarness(t)
	meta, _, _ := sampleFiles()
	_, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	transfer := decodeInto[transferJSON](t, body)

	resp, respBody := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/finalize", nil)
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("finalizing an unfinished transfer returned %d, want 409: %s", resp.StatusCode, respBody)
	}
	// And the slug still must not resolve.
	if pub, _ := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil); pub.StatusCode != http.StatusNotFound {
		t.Errorf("an unfinalized slug resolved with %d", pub.StatusCode)
	}
}

func TestAnotherUserCannotTouchYourTransfer(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)

	// A second account with its own session.
	other, err := h.db.UpsertUser(t.Context(), "sub-2", "someone@else.test", "Someone Else")
	if err != nil {
		t.Fatal(err)
	}
	token := h.newSession(t, other.ID)
	original := h.session
	h.session = token
	defer func() { h.session = original }()

	for _, attempt := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/transfers/" + transfer.ID, nil},
		{http.MethodPatch, "/api/transfers/" + transfer.ID, map[string]any{"slug": "stolen"}},
		{http.MethodDelete, "/api/transfers/" + transfer.ID, nil},
		{http.MethodPost, "/api/transfers/" + transfer.ID + "/finalize", nil},
	} {
		resp, _ := h.do(attempt.method, attempt.path, attempt.body)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s by another account returned %d, want 404", attempt.method, attempt.path, resp.StatusCode)
		}
	}
}

func TestUnauthenticatedRequestsAreRefused(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/api/me", "/api/transfers", "/api/transfers/resumable", "/api/admin/stats"} {
		resp, _ := h.public(http.MethodGet, path, nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without a session returned %d, want 401", path, resp.StatusCode)
		}
	}
}

func TestSuperadminIsServerDecided(t *testing.T) {
	h := newHarness(t)
	// The harness's superadmin is admin@collines.co; the signed-in user is not.
	resp, _ := h.do(http.MethodGet, "/api/admin/stats", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("a non-admin reached admin stats with status %d", resp.StatusCode)
	}
	_, body := h.do(http.MethodGet, "/api/me", nil)
	if !bytes.Contains(body, []byte(`"superadmin":false`)) {
		t.Errorf("/api/me should report superadmin false: %s", body)
	}
}

func TestDeleteRemovesObjectsAndLink(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	files, _ := h.db.FilesFor(t.Context(), transfer.ID)

	resp, _ := h.do(http.MethodDelete, "/api/transfers/"+transfer.ID, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deleting: %d", resp.StatusCode)
	}
	if gone, _ := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil); gone.StatusCode != http.StatusNotFound {
		t.Errorf("a deleted link still resolves: %d", gone.StatusCode)
	}
	// The objects should be gone from storage too, not just unlinked.
	head, err := http.Head(h.s3.URL + "/fret/" + files[0].ObjectKey)
	if err == nil {
		defer head.Body.Close()
		if head.StatusCode < 400 {
			t.Errorf("the object survived deletion with status %d", head.StatusCode)
		}
	}
}

func TestPreferencesRoundTrip(t *testing.T) {
	h := newHarness(t)
	resp, body := h.do(http.MethodPatch, "/api/me/preferences", map[string]any{
		"theme": "dark", "slugStyle": "words", "slugLength": 12, "defaultExpiry": "30d",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("saving preferences: %d %s", resp.StatusCode, body)
	}
	for _, want := range []string{`"theme":"dark"`, `"slugStyle":"words"`, `"slugLength":12`, `"defaultExpiry":"30d"`} {
		if !bytes.Contains(body, []byte(want)) {
			t.Errorf("preferences response missing %s: %s", want, body)
		}
	}

	// The slug style takes effect on the next upload, which is what makes it a
	// preference rather than a display setting.
	meta, _, _ := sampleFiles()
	_, created := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	transfer := decodeInto[transferJSON](t, created)
	if strings.Count(transfer.Slug, "-") != 2 {
		t.Errorf("with the words style the slug should be word-word-NN, got %q", transfer.Slug)
	}
	if transfer.Expiry != "30d" {
		t.Errorf("the new default expiry was not applied: %q", transfer.Expiry)
	}
}

func TestSlugLengthPreferenceIsHonoured(t *testing.T) {
	h := newHarness(t)
	h.do(http.MethodPatch, "/api/me/preferences", map[string]any{"slugStyle": "code", "slugLength": 5})
	meta, _, _ := sampleFiles()
	_, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	if slug := decodeInto[transferJSON](t, body).Slug; len(slug) != 5 {
		t.Errorf("slug %q is %d characters, want 5", slug, len(slug))
	}
}

func TestInvalidPreferencesAreRejected(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []map[string]any{
		{"theme": "neon"},
		{"defaultExpiry": "forever"},
	} {
		resp, _ := h.do(http.MethodPatch, "/api/me/preferences", bad)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%v was accepted with status %d", bad, resp.StatusCode)
		}
	}
	// Out-of-range values clamp rather than fail, since a slider cannot really
	// send anything meaningless.
	resp, body := h.do(http.MethodPatch, "/api/me/preferences", map[string]any{"slugLength": 999})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clamping should succeed, got %d", resp.StatusCode)
	}
	if bytes.Contains(body, []byte(`"slugLength":999`)) {
		t.Errorf("slug length was not clamped: %s", body)
	}
}

func TestDownloadsAreCounted(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)

	h.public(http.MethodGet, "/api/t/"+transfer.Slug+"/archive", nil)
	h.public(http.MethodGet, "/api/t/"+transfer.Slug+"/archive", nil)

	_, body := h.do(http.MethodGet, "/api/transfers", nil)
	if !bytes.Contains(body, []byte(`"downloads":2`)) {
		t.Errorf("two downloads were not counted: %s", body)
	}
}

func TestExpiredTransferStopsServing(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)

	// Reach past the API to place the expiry in the past.
	past := int64(1)
	if err := h.db.UpdateTransferSettings(t.Context(), transfer.ID, transfer.Slug, "", "24h", &past); err != nil {
		t.Fatal(err)
	}
	resp, body := h.public(http.MethodGet, "/api/t/"+transfer.Slug, nil)
	if resp.StatusCode != http.StatusGone {
		t.Errorf("an expired link returned %d, want 410", resp.StatusCode)
	}
	if !bytes.Contains(body, []byte("expired")) {
		t.Errorf("the response should say the link expired: %s", body)
	}
}

func TestUnlockAttemptsAreThrottled(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"password": "correct"})

	throttled := false
	for range 12 {
		resp, _ := h.public(http.MethodPost, "/api/t/"+transfer.Slug+"/unlock", map[string]any{"password": "wrong"})
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
			break
		}
	}
	if !throttled {
		t.Error("password guessing was never throttled")
	}
}

func TestSpaServesRecipientRoutes(t *testing.T) {
	h := newHarness(t)
	// A hard load of /<slug> must return the app, not a 404, so a recipient
	// link works when pasted into a fresh browser.
	resp, body := h.public(http.MethodGet, "/some-slug", nil)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("a recipient route returned %d", resp.StatusCode)
	}
	if resp.StatusCode == http.StatusOK && !bytes.Contains(body, []byte("<")) {
		t.Errorf("expected HTML from the SPA handler")
	}
}

func TestHealthEndpoint(t *testing.T) {
	h := newHarness(t)
	resp, body := h.public(http.MethodGet, "/api/health", nil)
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("ok")) {
		t.Errorf("health returned %d %s", resp.StatusCode, body)
	}
}

// ---------- harness helpers used above ----------

// completeTransfer uploads the sample drop and returns the finalized transfer.
func (h *harness) completeTransfer(t *testing.T) transferJSON {
	t.Helper()
	meta, contents, _ := sampleFiles()
	_, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	transfer := decodeInto[transferJSON](t, body)
	for i, file := range transfer.Files {
		h.uploadFile(transfer.ID, file, contents[i])
	}
	resp, finalBody := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/finalize", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("finalizing: %d %s", resp.StatusCode, finalBody)
	}
	return transfer
}

func (h *harness) newSession(t *testing.T, userID int64) string {
	t.Helper()
	token, err := auth.Token()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.db.CreateSession(t.Context(), token, userID, time.Hour); err != nil {
		t.Fatal(err)
	}
	return token
}

func fetch(t *testing.T, url string) []byte {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fetching %s returned %d", url, resp.StatusCode)
	}
	data, _ := io.ReadAll(resp.Body)
	return data
}

// TestPublicConfigIsReadableWithoutASession covers what the sign-in screen and
// the recipient page need before, or without, anyone signing in.
func TestPublicConfigIsReadableWithoutASession(t *testing.T) {
	h := newHarness(t)
	resp, body := h.public(http.MethodGet, "/api/config", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("public config returned %d", resp.StatusCode)
	}
	config := decodeInto[struct {
		AppName      string `json:"appName"`
		Locale       string `json:"locale"`
		PublicHost   string `json:"publicHost"`
		ProviderHost string `json:"providerHost"`
	}](t, body)

	if config.AppName != "Fret" {
		t.Errorf("app name is %q", config.AppName)
	}
	if config.PublicHost != "fret.test" {
		t.Errorf("public host is %q, want the host alone", config.PublicHost)
	}
	// The sign-in screen names the identity provider, so this must be the
	// issuer's host and not Fret's own.
	if config.ProviderHost != "oidc.test" {
		t.Errorf("provider host is %q, want the issuer's host", config.ProviderHost)
	}
	// Nothing here may leak configuration a stranger should not see.
	for _, secret := range []string{"secret", "key", "xxxxxxxx"} {
		if strings.Contains(strings.ToLower(string(body)), secret) {
			t.Errorf("public config may be leaking configuration: %s", body)
		}
	}
}

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://id.example.com":          "id.example.com",
		"https://id.example.com/realms/x": "id.example.com",
		"http://localhost:9000":           "localhost:9000",
		"id.example.com":                  "id.example.com",
		"":                                "",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestSharedSlugStaysReserved covers the restore tag's guarantee: once a link
// has been handed out under a name, renaming must not let that name get away,
// or the offer to restore it would sometimes fail.
func TestSharedSlugStaysReserved(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	original := transfer.Slug

	// Nothing is recorded until the link is actually copied.
	_, before := h.do(http.MethodGet, "/api/transfers/"+transfer.ID, nil)
	if !bytes.Contains(before, []byte(`"sharedSlug":""`)) {
		t.Errorf("an uncopied transfer should have no shared slug: %s", before)
	}

	resp, body := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/shared", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("marking shared: %d %s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"sharedSlug":"`+original+`"`)) {
		t.Fatalf("shared slug was not recorded: %s", body)
	}

	// Rename away from it.
	if resp, body := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID,
		map[string]any{"slug": "renamed-once"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("renaming: %d %s", resp.StatusCode, body)
	}
	// The old name must stop resolving — renaming exists to kill a link you
	// sent to the wrong person.
	if gone, _ := h.public(http.MethodGet, "/api/t/"+original, nil); gone.StatusCode != http.StatusNotFound {
		t.Errorf("the old link still resolves with %d", gone.StatusCode)
	}

	// And no one else may take it while this transfer can still restore it.
	other := h.completeTransfer(t)
	steal, stealBody := h.do(http.MethodPatch, "/api/transfers/"+other.ID, map[string]any{"slug": original})
	if steal.StatusCode != http.StatusConflict {
		t.Errorf("another transfer claimed a reserved shared slug: %d %s", steal.StatusCode, stealBody)
	}

	// Restoring works.
	restore, restoreBody := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"slug": original})
	if restore.StatusCode != http.StatusOK {
		t.Fatalf("restoring the shared slug failed: %d %s", restore.StatusCode, restoreBody)
	}
	if back, _ := h.public(http.MethodGet, "/api/t/"+original, nil); back.StatusCode != http.StatusOK {
		t.Errorf("the restored link does not resolve: %d", back.StatusCode)
	}
}

// TestSharedSlugIsWrittenOnce keeps the restore anchor pointing at the name
// people actually received.
func TestSharedSlugIsWrittenOnce(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	original := transfer.Slug

	h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/shared", nil)
	h.do(http.MethodPatch, "/api/transfers/"+transfer.ID, map[string]any{"slug": "second-name"})
	// Copying again after a rename must not move the anchor.
	_, body := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/shared", nil)

	if !bytes.Contains(body, []byte(`"sharedSlug":"`+original+`"`)) {
		t.Errorf("the shared slug moved after a rename: %s", body)
	}
}

// TestMintSlugRedrawsWithoutDisturbingAnythingElse covers the Shuffle beside
// the link field. Drawing a new name is the one settings change the browser
// makes without sending a value, so nothing it does not send may move.
func TestMintSlugRedrawsWithoutDisturbingAnythingElse(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	original := transfer.Slug

	if resp, body := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID,
		map[string]any{"password": "colour", "expiry": "30d"}); resp.StatusCode != http.StatusOK {
		t.Fatalf("setting up: %d %s", resp.StatusCode, body)
	}

	resp, body := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/slug", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("minting a slug: %d %s", resp.StatusCode, body)
	}

	minted := decodeInto[struct {
		Slug     string `json:"slug"`
		Expiry   string `json:"expiry"`
		Password bool   `json:"hasPassword"`
	}](t, body)
	if minted.Slug == original {
		t.Errorf("the name did not change: %s", minted.Slug)
	}
	if err := slug.Validate(minted.Slug); err != nil {
		t.Errorf("minted an invalid slug %q: %v", minted.Slug, err)
	}
	if !minted.Password || minted.Expiry != "30d" {
		t.Errorf("a redraw disturbed the settings beside it: %s", body)
	}

	// The link has to follow the name, in both directions.
	if gone, _ := h.public(http.MethodGet, "/api/t/"+original, nil); gone.StatusCode != http.StatusNotFound {
		t.Errorf("the old link still resolves: %d", gone.StatusCode)
	}
	if live, _ := h.public(http.MethodGet, "/api/t/"+minted.Slug, nil); live.StatusCode != http.StatusOK {
		t.Errorf("the new link does not resolve: %d", live.StatusCode)
	}
}

// A redraw is a settings change like any other, so it answers to the same
// ownership check rather than to none.
func TestMintSlugRefusesAnotherUsersTransfer(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)

	other, err := h.db.UpsertUser(t.Context(), "sub-3", "third@else.test", "Third Party")
	if err != nil {
		t.Fatal(err)
	}
	original := h.session
	h.session = h.newSession(t, other.ID)
	defer func() { h.session = original }()

	resp, _ := h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/slug", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("another account redrew a link: %d", resp.StatusCode)
	}
}

// A transfer must still be allowed to keep its own name.
func TestTransferCanKeepItsOwnSlug(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	h.do(http.MethodPost, "/api/transfers/"+transfer.ID+"/shared", nil)

	resp, body := h.do(http.MethodPatch, "/api/transfers/"+transfer.ID,
		map[string]any{"slug": transfer.Slug, "expiry": "30d"})
	if resp.StatusCode != http.StatusOK {
		t.Errorf("a transfer was blocked by its own reservation: %d %s", resp.StatusCode, body)
	}
}

// TestDownloadUrlCarriesNoResponseOverrides keeps the presigned download URL
// as plain as possible.
//
// Every signed query parameter has to be percent-encoded identically by the
// SDK, by any proxy in front of the bucket and by the storage backend. A
// response-content-disposition value carries spaces, quotes, semicolons and
// apostrophes, so it is the most likely of all of them to be encoded slightly
// differently somewhere in that chain and rejected. The object carries its own
// filename, so the parameter buys nothing.
func TestDownloadUrlCarriesNoResponseOverrides(t *testing.T) {
	h := newHarness(t)
	transfer := h.completeTransfer(t)
	files, err := h.db.FilesFor(t.Context(), transfer.ID)
	if err != nil {
		t.Fatal(err)
	}

	resp, _ := h.public(http.MethodGet, fmt.Sprintf("/api/t/%s/files/%s", transfer.Slug, files[0].ID), nil)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected a redirect, got %d", resp.StatusCode)
	}
	location := resp.Header.Get("Location")

	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("the redirect target does not parse: %v", err)
	}
	for parameter := range parsed.Query() {
		if strings.HasPrefix(strings.ToLower(parameter), "response-") {
			t.Errorf("presigned URL carries %q; the object already knows its own name", parameter)
		}
	}
	// The signature must still be there, or this test would pass on a URL that
	// simply lost its query string.
	if parsed.Query().Get("X-Amz-Signature") == "" {
		t.Error("presigned URL has no signature")
	}
}

// The filename a recipient sees comes from the object, so it has to be set
// when the upload is opened rather than at download time.
func TestObjectsCarryTheirFilename(t *testing.T) {
	h := newHarness(t)
	meta := []map[string]any{
		{"name": "Bureau Pantin.lh3d.zip", "size": 64, "type": "application/zip"},
	}
	_, body := h.do(http.MethodPost, "/api/transfers", map[string]any{"files": meta})
	transfer := decodeInto[transferJSON](t, body)
	if got := transfer.Files[0].Name; got != "Bureau Pantin.lh3d.zip" {
		t.Errorf("a name with a space did not survive: %q", got)
	}
	// And it must remain intact through the key, which is separately sanitised.
	files, _ := h.db.FilesFor(t.Context(), transfer.ID)
	if !strings.HasSuffix(files[0].ObjectKey, "Bureau Pantin.lh3d.zip") {
		t.Errorf("object key lost the filename: %q", files[0].ObjectKey)
	}
}
