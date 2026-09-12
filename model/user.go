package model

type UserRole string

const (
	UserRoleGuest UserRole = "guest"
	UserRoleUser  UserRole = "user"
	UserRoleAdmin UserRole = "admin"
)

type UserStatus string

const (
	UserStatusActive UserStatus = "active"
	UserStatusBan    UserStatus = "ban"
)

// User 系统用户。
type User struct {
	ID          string     `json:"id" gorm:"primaryKey"`
	Username    string     `json:"username" gorm:"uniqueIndex"`
	Password    string     `json:"password,omitempty"`
	Email       string     `json:"email"`
	DisplayName string     `json:"displayName"`
	AvatarURL   string     `json:"avatarUrl"`
	Role        UserRole   `json:"role"`
	Group       string     `json:"group" gorm:"index"`
	Credits     int        `json:"credits"`
	AffCode     string     `json:"affCode" gorm:"uniqueIndex"`
	AffCount    int        `json:"affCount"`
	InviterID   string     `json:"inviterId"`
	GithubID    string     `json:"githubId"`
	LinuxDoID   string     `json:"linuxDoId" gorm:"index"`
	WechatID    string     `json:"wechatId"`
	Status      UserStatus `json:"status"`
	LastLoginAt string     `json:"lastLoginAt"`
	Extra       string     `json:"extra" gorm:"type:text"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
}

// UserList 用户分页结果。
type UserList struct {
	Items []User `json:"items"`
	Total int    `json:"total"`
}

// AuthUser 用户公开信息。
type AuthUser struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	AvatarURL   string   `json:"avatarUrl"`
	Role        UserRole `json:"role"`
	Group       string   `json:"group"`
	Credits     int      `json:"credits"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// AuthSession 登录会话信息。
type AuthSession struct {
	Token string   `json:"token"`
	User  AuthUser `json:"user"`
}

func PublicUser(user User) AuthUser {
	if user.Group == "" {
		user.Group = "default"
	}
	return AuthUser{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        user.Role,
		Group:       user.Group,
		Credits:     user.Credits,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

type CreditLogType string

const (
	CreditLogTypeAdminAdjust CreditLogType = "admin_adjust"
	CreditLogTypeAIConsume   CreditLogType = "ai_consume"
	CreditLogTypeAIRefund    CreditLogType = "ai_refund"
	CreditLogTypeRedeemTopup CreditLogType = "redeem_topup"
)

// CreditLog 用户算力点变更流水。
type CreditLog struct {
	ID        string         `json:"id" gorm:"primaryKey"`
	UserID    string         `json:"userId" gorm:"index"`
	User      *CreditLogUser `json:"user,omitempty" gorm:"-"`
	Type      CreditLogType  `json:"type"`
	Amount    int            `json:"amount"`
	Balance   int            `json:"balance"`
	RelatedID string         `json:"relatedId"`
	Remark    string         `json:"remark"`
	Extra     string         `json:"extra" gorm:"type:text"`
	CreatedAt string         `json:"createdAt"`
}

type CreditLogUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
	Email       string `json:"email"`
}

type CreditLogList struct {
	Items []CreditLog    `json:"items"`
	Total int            `json:"total"`
	Stats CreditLogStats `json:"stats"`
}

type CreditLogStats struct {
	Consume int `json:"consume"`
	Refund  int `json:"refund"`
	Net     int `json:"net"`
	Count   int `json:"count"`
}

type RedemptionCodeStatus string

const (
	RedemptionCodeStatusEnabled  RedemptionCodeStatus = "enabled"
	RedemptionCodeStatusDisabled RedemptionCodeStatus = "disabled"
	RedemptionCodeStatusUsed     RedemptionCodeStatus = "used"
)

// RedemptionCode 用户充值兑换码。
type RedemptionCode struct {
	ID        string               `json:"id" gorm:"primaryKey"`
	Code      string               `json:"code" gorm:"uniqueIndex;size:64"`
	Name      string               `json:"name" gorm:"index"`
	Credits   int                  `json:"credits"`
	Status    RedemptionCodeStatus `json:"status" gorm:"index"`
	CreatedBy string               `json:"createdBy" gorm:"index"`
	UsedBy    string               `json:"usedBy" gorm:"index"`
	UsedAt    string               `json:"usedAt"`
	ExpiresAt string               `json:"expiresAt" gorm:"index"`
	Remark    string               `json:"remark"`
	CreatedAt string               `json:"createdAt"`
	UpdatedAt string               `json:"updatedAt"`
}

type RedemptionCodeList struct {
	Items []RedemptionCode `json:"items"`
	Total int              `json:"total"`
}
