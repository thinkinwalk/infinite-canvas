package model

type ClientAPIKey struct {
	ID        string `json:"id" gorm:"primaryKey"`
	UserID    string `json:"-" gorm:"index"`
	Name      string `json:"name"`
	Prefix    string `json:"prefix"`
	Digest    string `json:"-" gorm:"uniqueIndex;size:64"`
	CreatedAt string `json:"created_at"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

// A voice is a private reference recording, not a trained model.
type Voice struct {
	ID              string  `json:"voice_id" gorm:"primaryKey"`
	UserID          string  `json:"-" gorm:"index"`
	Name            string  `json:"name"`
	ReferenceText   string  `json:"reference_text" gorm:"type:text"`
	Language        string  `json:"language"`
	Version         string  `json:"version"`
	ReferenceFile   string  `json:"-"`
	MimeType        string  `json:"mime_type"`
	Bytes           int64   `json:"bytes"`
	DurationSeconds float64 `json:"duration_seconds"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
	DisabledAt      string  `json:"disabled_at,omitempty"`
}
