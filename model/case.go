package model

// CaseStatus is the lifecycle state of a packaged workflow application.
type CaseStatus string

const (
	CaseStatusDraft     CaseStatus = "draft"
	CaseStatusPending   CaseStatus = "pending"
	CaseStatusPublished CaseStatus = "published"
	CaseStatusRejected  CaseStatus = "rejected"
	CaseStatusOffline   CaseStatus = "offline"
)

// CaseApp is a packaged workflow. Private execution fields are intentionally
// omitted from JSON responses and are only read by server-side execution.
type CaseApp struct {
	ID                  string     `json:"id" gorm:"primaryKey"`
	OwnerID             string     `json:"ownerId" gorm:"index"`
	Title               string     `json:"title"`
	Description         string     `json:"description"`
	CoverURL            string     `json:"coverUrl"`
	DemoURL             string     `json:"demoUrl"`
	Category            string     `json:"category" gorm:"index"`
	Tags                []string   `json:"tags" gorm:"serializer:json"`
	Status              CaseStatus `json:"status" gorm:"index"`
	IsOfficial          bool       `json:"isOfficial" gorm:"index"`
	PublicSchema        string     `json:"publicSchema" gorm:"type:text"`
	WorkflowSnapshot    string     `json:"-" gorm:"type:text"`
	RuntimeConfig       string     `json:"-" gorm:"type:text"`
	PriceCredits        int        `json:"priceCredits"`
	MemberPriceCredits  int        `json:"memberPriceCredits"`
	CostCredits         int        `json:"-"`
	RevenueSharePercent int        `json:"-"`
	ViewCount           int        `json:"viewCount"`
	RunCount            int        `json:"runCount"`
	UnlockCount         int        `json:"unlockCount"`
	ReviewNote          string     `json:"reviewNote" gorm:"type:text"`
	PublishedVersion    int        `json:"publishedVersion"`
	CreatedAt           string     `json:"createdAt"`
	UpdatedAt           string     `json:"updatedAt"`
}

// CaseRun records one customer execution and its case-level fee allocation.
type CaseRun struct {
	ID              string `json:"id" gorm:"primaryKey"`
	CaseID          string `json:"caseId" gorm:"index"`
	UserID          string `json:"userId" gorm:"index"`
	Version         int    `json:"version"`
	Status          string `json:"status" gorm:"index"`
	ChargedCredits  int    `json:"chargedCredits"`
	AuthorCredits   int    `json:"authorCredits"`
	PlatformCredits int    `json:"platformCredits"`
	ResponseBody    string `json:"responseBody,omitempty" gorm:"type:text"`
	ErrorMessage    string `json:"errorMessage,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

type CaseList struct {
	Items []CaseApp `json:"items"`
	Total int       `json:"total"`
}
