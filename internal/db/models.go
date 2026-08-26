package db

import "time"

// User mirrors an account in the OIDC provider. Fret never creates accounts;
// a row appears the first time a known identity signs in.
type User struct {
	ID            int64  `json:"-"`
	Subject       string `json:"-"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	Theme         string `json:"theme"`
	SlugStyle     string `json:"slugStyle"`
	SlugLength    int    `json:"slugLength"`
	DefaultExpiry string `json:"defaultExpiry"`
	CreatedAt     int64  `json:"-"`
	LastSeenAt    int64  `json:"-"`
}

// Initials renders the avatar pill's label: at most two letters.
func (u *User) Initials() string {
	source := u.Name
	if source == "" {
		source = u.Email
	}
	var out []rune
	prevBlank := true
	for _, r := range source {
		switch {
		case r == ' ' || r == '.' || r == '_' || r == '-' || r == '@':
			prevBlank = true
		case prevBlank:
			out = append(out, r)
			prevBlank = false
			if len(out) == 2 {
				return upper(string(out))
			}
		}
	}
	if len(out) == 0 {
		return "??"
	}
	return upper(string(out))
}

func upper(s string) string {
	b := []rune(s)
	for i, r := range b {
		if r >= 'a' && r <= 'z' {
			b[i] = r - 32
		}
	}
	return string(b)
}

type TransferStatus string

const (
	StatusPending TransferStatus = "pending"
	StatusLive    TransferStatus = "live"
	StatusDeleted TransferStatus = "deleted"
)

type Transfer struct {
	ID           string `json:"id"`
	UserID       int64  `json:"-"`
	Slug         string `json:"slug"`
	SharedSlug   string `json:"sharedSlug"`
	Status       string `json:"status"`
	PasswordHash string `json:"-"`
	HasPassword  bool   `json:"hasPassword"`
	ExpiresAt    *int64 `json:"expiresAt"`
	TotalBytes   int64  `json:"totalBytes"`
	Downloads    int64  `json:"downloads"`
	CreatedAt    int64  `json:"createdAt"`
	CompletedAt  *int64 `json:"completedAt"`
	UpdatedAt    int64  `json:"-"`
	Files        []File `json:"files,omitempty"`
	FileCount    int    `json:"fileCount"`
	// FirstFile is the name of the earliest file in the transfer, which is
	// what the transfers list shows as a row's title. Populated only by
	// ListTransfers; nothing else needs it.
	FirstFile  string `json:"firstFile,omitempty"`
	SenderName string `json:"senderName,omitempty"`
	Expiry     string `json:"expiry"` // symbolic: 24h | 7d | 30d | never
}

// Expired reports whether the transfer's window has closed.
func (t *Transfer) Expired(now time.Time) bool {
	return t.ExpiresAt != nil && *t.ExpiresAt <= now.Unix()
}

type File struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	ObjectKey string `json:"-"`
	UploadID  string `json:"-"`
	PartSize  int64  `json:"partSize,omitempty"`
	Status    string `json:"status"`
	CRC32     *int64 `json:"-"`
	Position  int    `json:"-"`
}

type Part struct {
	PartNumber int32  `json:"partNumber"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size"`
}
