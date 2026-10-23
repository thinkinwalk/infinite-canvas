package model

// VideoTask records a billed asynchronous video request without storing channel credentials.
type VideoTask struct {
	PlatformModelID string `json:"platformModelId,omitempty"`
	ModelLabel      string `json:"modelLabel,omitempty"`
	FeatureID       string `json:"featureId,omitempty"`
	ConfigRevision  int    `json:"configRevision,omitempty"`
	ID              string `json:"id" gorm:"primaryKey"`
	UserID          string `json:"userId" gorm:"index"`
	Model           string `json:"model" gorm:"index"`
	Credits         int    `json:"credits"`
	Path            string `json:"path"`
	Status          string `json:"status" gorm:"index"`
	OutputURL       string `json:"-"`
	Refunded        bool   `json:"refunded" gorm:"index"`
	ChannelID       int    `json:"channelId"`
	ChannelName     string `json:"channelName"`
	ChannelBaseURL  string `json:"channelBaseUrl"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}
