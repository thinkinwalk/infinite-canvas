package model

// ReplicateTask owns one cloud prediction and its one-time platform charge.
type ReplicateTask struct {
	ID              string  `json:"id" gorm:"primaryKey"`
	UserID          string  `json:"-" gorm:"index"`
	ChannelID       int     `json:"channelId"`
	ChannelName     string  `json:"channelName"`
	Operation       string  `json:"operation"`
	Model           string  `json:"model"`
	Version         string  `json:"version"`
	RequestHash     string  `json:"-"`
	PredictionID    string  `json:"predictionId" gorm:"index"`
	ProviderKey     *string `json:"-" gorm:"uniqueIndex"`
	Status          string  `json:"status" gorm:"index"`
	Credits         int     `json:"credits"`
	PricingSnapshot string  `json:"pricingSnapshot" gorm:"type:text"`
	Refunded        bool    `json:"refunded"`
	OutputURL       string  `json:"-"`
	// OutputURLs preserves iterator-style provider output (for example SAM 2
	// may return one URI per mask frame). OutputURL remains the single-file
	// fast path used by the other models.
	OutputURLs string `json:"-" gorm:"type:text"`
	ResultFile string `json:"-"`
	ResultJSON string `json:"-" gorm:"type:text"`
	MimeType   string `json:"mimeType"`
	Error      string `json:"error,omitempty"`
	Metrics    string `json:"metrics" gorm:"type:text"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// ReferenceMediaOwner records ownership of public opaque reference URLs.
type ReferenceMediaOwner struct {
	ID              string `gorm:"primaryKey"`
	UserID          string `gorm:"index"`
	MimeType        string
	Bytes           int64
	DurationSeconds float64
}
