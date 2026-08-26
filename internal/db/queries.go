package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrSlugTaken = errors.New("slug already in use")
)

// ---------- users ----------

// UpsertUser records an identity seen from the OIDC provider, preserving any
// preferences the account already carries.
func (d *DB) UpsertUser(ctx context.Context, subject, email, name string) (*User, error) {
	now := time.Now().Unix()
	_, err := d.ExecContext(ctx, `
		INSERT INTO users (subject, email, name, created_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(subject) DO UPDATE SET
			email = excluded.email,
			name = excluded.name,
			last_seen_at = excluded.last_seen_at`,
		subject, email, name, now, now)
	if err != nil {
		return nil, fmt.Errorf("upsert user: %w", err)
	}
	return d.UserBySubject(ctx, subject)
}

const userCols = `id, subject, email, name, theme, slug_style, slug_length, default_expiry, created_at, last_seen_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Subject, &u.Email, &u.Name, &u.Theme,
		&u.SlugStyle, &u.SlugLength, &u.DefaultExpiry, &u.CreatedAt, &u.LastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (d *DB) UserBySubject(ctx context.Context, subject string) (*User, error) {
	return scanUser(d.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE subject = ?`, subject))
}

func (d *DB) UserByID(ctx context.Context, id int64) (*User, error) {
	return scanUser(d.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// UpdatePreferences persists the settings that follow a user between devices.
func (d *DB) UpdatePreferences(ctx context.Context, userID int64, theme, slugStyle string, slugLength int, defaultExpiry string) error {
	_, err := d.ExecContext(ctx, `
		UPDATE users SET theme = ?, slug_style = ?, slug_length = ?, default_expiry = ?
		WHERE id = ?`, theme, slugStyle, slugLength, defaultExpiry, userID)
	return err
}

func (d *DB) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// ---------- sessions ----------

func (d *DB) CreateSession(ctx context.Context, id string, userID int64, ttl time.Duration) error {
	now := time.Now()
	_, err := d.ExecContext(ctx, `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		id, userID, now.Unix(), now.Add(ttl).Unix())
	return err
}

// SessionUser resolves a session token to its account, treating an expired
// session as absent.
func (d *DB) SessionUser(ctx context.Context, id string) (*User, error) {
	return scanUser(d.QueryRowContext(ctx, `
		SELECT `+prefixCols(userCols, "u")+`
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = ? AND s.expires_at > ?`, id, time.Now().Unix()))
}

func (d *DB) DeleteSession(ctx context.Context, id string) error {
	_, err := d.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	return err
}

func prefixCols(cols, alias string) string {
	parts := strings.Split(cols, ", ")
	for i, p := range parts {
		parts[i] = alias + "." + p
	}
	return strings.Join(parts, ", ")
}

// ---------- transfers ----------

// CreateTransfer reserves the slug and the transfer row in one statement, so
// two people uploading at the same instant cannot claim the same link.
func (d *DB) CreateTransfer(ctx context.Context, t *Transfer, files []File) error {
	return d.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO transfers (id, user_id, slug, status, password_hash, expiry, expires_at,
			                       total_bytes, created_at, updated_at)
			VALUES (?, ?, ?, 'pending', '', ?, ?, ?, ?, ?)`,
			t.ID, t.UserID, t.Slug, t.Expiry, t.ExpiresAt, t.TotalBytes, t.CreatedAt, t.CreatedAt)
		if err != nil {
			if isUnique(err) {
				return ErrSlugTaken
			}
			return fmt.Errorf("insert transfer: %w", err)
		}
		for i := range files {
			f := &files[i]
			_, err := tx.ExecContext(ctx, `
				INSERT INTO files (id, transfer_id, name, size, object_key, upload_id,
				                   part_size, status, position, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
				f.ID, t.ID, f.Name, f.Size, f.ObjectKey, f.UploadID, f.PartSize, i, t.CreatedAt)
			if err != nil {
				return fmt.Errorf("insert file: %w", err)
			}
		}
		return nil
	})
}

const transferCols = `id, user_id, slug, shared_slug, status, password_hash, expiry, expires_at, total_bytes, downloads, created_at, completed_at, updated_at`

func scanTransfer(row interface{ Scan(...any) error }) (*Transfer, error) {
	var t Transfer
	err := row.Scan(&t.ID, &t.UserID, &t.Slug, &t.SharedSlug, &t.Status, &t.PasswordHash, &t.Expiry, &t.ExpiresAt,
		&t.TotalBytes, &t.Downloads, &t.CreatedAt, &t.CompletedAt, &t.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.HasPassword = t.PasswordHash != ""
	return &t, nil
}

func (d *DB) TransferByID(ctx context.Context, id string) (*Transfer, error) {
	return scanTransfer(d.QueryRowContext(ctx, `SELECT `+transferCols+` FROM transfers WHERE id = ? AND status != 'deleted'`, id))
}

// TransferBySlug resolves a public link. Only live transfers resolve: a slug
// is reserved from the first byte but does not work until the upload lands.
func (d *DB) TransferBySlug(ctx context.Context, slug string) (*Transfer, error) {
	return scanTransfer(d.QueryRowContext(ctx, `SELECT `+transferCols+` FROM transfers WHERE slug = ? COLLATE NOCASE AND status = 'live'`, slug))
}

// SlugExists reports whether a name is spoken for. A transfer holds both the
// name it currently answers to and the one it was shared under, so a link that
// was handed out can always be restored rather than lost to someone else.
func (d *DB) SlugExists(ctx context.Context, slug, excludeTransferID string) (bool, error) {
	var n int
	err := d.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM transfers
		WHERE id != ?
		  AND status != 'deleted'
		  AND (slug = ? COLLATE NOCASE OR shared_slug = ? COLLATE NOCASE)`,
		excludeTransferID, slug, slug).Scan(&n)
	return n > 0, err
}

// MarkShared records the name a link was first handed out under. It is written
// once: a later rename must not move the anchor it can be restored to.
func (d *DB) MarkShared(ctx context.Context, id string) error {
	_, err := d.ExecContext(ctx, `
		UPDATE transfers SET shared_slug = slug
		WHERE id = ? AND shared_slug = '' AND status = 'live'`, id)
	return err
}

// ListTransfers returns a user's transfers, newest first, for the sheet.
func (d *DB) ListTransfers(ctx context.Context, userID int64) ([]Transfer, error) {
	// A transfer is remembered by what is in it, so the list carries one file
	// name per row. Ordered by position, which is the order the files were
	// dropped in — the same order the sender was looking at when they sent it,
	// and the same one the recipient sees. Ordering by rowid would usually
	// agree and would stop agreeing the moment anything reinserts a row.
	rows, err := d.QueryContext(ctx, `
		SELECT `+prefixCols(transferCols, "t")+`, COUNT(f.id),
		       COALESCE((SELECT name FROM files WHERE transfer_id = t.id
		                 ORDER BY position LIMIT 1), '')
		FROM transfers t LEFT JOIN files f ON f.transfer_id = t.id
		WHERE t.user_id = ? AND t.status = 'live'
		GROUP BY t.id
		ORDER BY t.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Transfer
	for rows.Next() {
		var t Transfer
		if err := rows.Scan(&t.ID, &t.UserID, &t.Slug, &t.SharedSlug, &t.Status, &t.PasswordHash, &t.Expiry, &t.ExpiresAt,
			&t.TotalBytes, &t.Downloads, &t.CreatedAt, &t.CompletedAt, &t.UpdatedAt, &t.FileCount, &t.FirstFile); err != nil {
			return nil, err
		}
		t.HasPassword = t.PasswordHash != ""
		out = append(out, t)
	}
	return out, rows.Err()
}

// PendingTransfers lists uploads that never finished, so the client can offer
// to resume them.
func (d *DB) PendingTransfers(ctx context.Context, userID int64) ([]Transfer, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT `+transferCols+` FROM transfers
		WHERE user_id = ? AND status = 'pending'
		ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transfer
	for rows.Next() {
		t, err := scanTransfer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// UpdateTransferSettings applies the slug/password/expiry edit, rejecting a
// slug another live transfer already holds.
func (d *DB) UpdateTransferSettings(ctx context.Context, id, slug, passwordHash, expiry string, expiresAt *int64) error {
	res, err := d.ExecContext(ctx, `
		UPDATE transfers SET slug = ?, password_hash = ?, expiry = ?, expires_at = ?, updated_at = ?
		WHERE id = ? AND status != 'deleted'`,
		slug, passwordHash, expiry, expiresAt, time.Now().Unix(), id)
	if err != nil {
		if isUnique(err) {
			return ErrSlugTaken
		}
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// FinalizeTransfer flips a fully uploaded transfer live, which is the moment
// its slug starts resolving.
func (d *DB) FinalizeTransfer(ctx context.Context, id string, totalBytes int64) error {
	now := time.Now().Unix()
	_, err := d.ExecContext(ctx, `
		UPDATE transfers SET status = 'live', total_bytes = ?, completed_at = ?, updated_at = ?
		WHERE id = ? AND status = 'pending'`, totalBytes, now, now, id)
	return err
}

func (d *DB) IncrementDownloads(ctx context.Context, id string) {
	_, _ = d.ExecContext(ctx, `UPDATE transfers SET downloads = downloads + 1 WHERE id = ?`, id)
}

func (d *DB) DeleteTransfer(ctx context.Context, id string) error {
	_, err := d.ExecContext(ctx, `DELETE FROM transfers WHERE id = ?`, id)
	return err
}

// ---------- files and parts ----------

func (d *DB) FilesFor(ctx context.Context, transferID string) ([]File, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT id, name, size, object_key, upload_id, part_size, status, crc32, position
		FROM files WHERE transfer_id = ? ORDER BY position`, transferID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []File
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.ID, &f.Name, &f.Size, &f.ObjectKey, &f.UploadID,
			&f.PartSize, &f.Status, &f.CRC32, &f.Position); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (d *DB) FileByID(ctx context.Context, transferID, fileID string) (*File, error) {
	var f File
	err := d.QueryRowContext(ctx, `
		SELECT id, name, size, object_key, upload_id, part_size, status, crc32, position
		FROM files WHERE id = ? AND transfer_id = ?`, fileID, transferID).
		Scan(&f.ID, &f.Name, &f.Size, &f.ObjectKey, &f.UploadID, &f.PartSize, &f.Status, &f.CRC32, &f.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &f, err
}

// RecordPart notes a part that reached S3 intact. Re-uploading a part simply
// overwrites the row, which keeps retries idempotent.
func (d *DB) RecordPart(ctx context.Context, fileID string, p Part) error {
	_, err := d.ExecContext(ctx, `
		INSERT INTO parts (file_id, part_number, etag, size, uploaded_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(file_id, part_number) DO UPDATE SET
			etag = excluded.etag, size = excluded.size, uploaded_at = excluded.uploaded_at`,
		fileID, p.PartNumber, p.ETag, p.Size, time.Now().Unix())
	return err
}

func (d *DB) PartsFor(ctx context.Context, fileID string) ([]Part, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT part_number, etag, size FROM parts WHERE file_id = ? ORDER BY part_number`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Part
	for rows.Next() {
		var p Part
		if err := rows.Scan(&p.PartNumber, &p.ETag, &p.Size); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) MarkFileComplete(ctx context.Context, fileID string, crc *int64) error {
	_, err := d.ExecContext(ctx, `UPDATE files SET status = 'complete', upload_id = '', crc32 = ? WHERE id = ?`, crc, fileID)
	return err
}

// ---------- unlocks ----------

func (d *DB) CreateUnlock(ctx context.Context, token, transferID string, ttl time.Duration) error {
	_, err := d.ExecContext(ctx, `INSERT INTO unlocks (token, transfer_id, expires_at) VALUES (?, ?, ?)`,
		token, transferID, time.Now().Add(ttl).Unix())
	return err
}

func (d *DB) UnlockValid(ctx context.Context, token, transferID string) bool {
	var n int
	err := d.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM unlocks WHERE token = ? AND transfer_id = ? AND expires_at > ?`,
		token, transferID, time.Now().Unix()).Scan(&n)
	return err == nil && n > 0
}

// ---------- sweeping ----------

// ExpiredTransfers returns transfers past their window, for deletion.
func (d *DB) ExpiredTransfers(ctx context.Context, now time.Time, limit int) ([]Transfer, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT `+transferCols+` FROM transfers
		WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'deleted'
		LIMIT ?`, now.Unix(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transfer
	for rows.Next() {
		t, err := scanTransfer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// StaleTransfers finds uploads abandoned mid-flight, whose S3 multipart
// uploads are still holding storage.
func (d *DB) StaleTransfers(ctx context.Context, before time.Time, limit int) ([]Transfer, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT `+transferCols+` FROM transfers
		WHERE status = 'pending' AND updated_at <= ?
		LIMIT ?`, before.Unix(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transfer
	for rows.Next() {
		t, err := scanTransfer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (d *DB) Touch(ctx context.Context, transferID string) {
	_, _ = d.ExecContext(ctx, `UPDATE transfers SET updated_at = ? WHERE id = ?`, time.Now().Unix(), transferID)
}

// PruneExpired clears rows whose only purpose has passed.
func (d *DB) PruneExpired(ctx context.Context) {
	now := time.Now().Unix()
	_, _ = d.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now)
	_, _ = d.ExecContext(ctx, `DELETE FROM unlocks WHERE expires_at <= ?`, now)
}

// StorageUsed totals live bytes, either for one user or for everyone.
func (d *DB) StorageUsed(ctx context.Context, userID *int64) (int64, error) {
	var total sql.NullInt64
	var err error
	if userID == nil {
		err = d.QueryRowContext(ctx, `SELECT SUM(total_bytes) FROM transfers WHERE status = 'live'`).Scan(&total)
	} else {
		err = d.QueryRowContext(ctx, `SELECT SUM(total_bytes) FROM transfers WHERE status = 'live' AND user_id = ?`, *userID).Scan(&total)
	}
	return total.Int64, err
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique constraint")
}
