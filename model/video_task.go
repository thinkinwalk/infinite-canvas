package model

// VideoTask records a billed asynchronous video request without storing channel credentials.
type VideoTask struct {
	ID             string `json:"id" gorm:"primaryKey"`
	UserID         string `json:"userId" gorm:"index"`
	Model          string `json:"model" gorm:"index"`
	Credits        int    `json:"credits"`
	Path           string `json:"path"`
	Status         string `json:"status" gorm:"index"`
	Refunded       bool   `json:"refunded" gorm:"index"`
	ChannelName    string `json:"channelName"`
	ChannelBaseURL string `json:"channelBaseUrl"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}
