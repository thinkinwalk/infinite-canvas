package repository

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func setupRedemptionTestDB(t *testing.T) {
	t.Helper()
	oldCfg := config.Cfg
	oldDB := db
	oldErr := dbErr
	oldOnce := dbOnce
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "test.db")}
	db = nil
	dbErr = nil
	dbOnce = sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			if sqlDB, err := db.DB(); err == nil {
				_ = sqlDB.Close()
			}
		}
		config.Cfg = oldCfg
		db = oldDB
		dbErr = oldErr
		dbOnce = oldOnce
	})
}

func TestRedeemCodeCreditsUserOnceAndWritesLog(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	user, err := SaveUser(model.User{
		ID:        "user-1",
		Username:  "redeemer",
		Role:      model.UserRoleUser,
		Credits:   10,
		Status:    model.UserStatusActive,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("save user: %v", err)
	}
	code, err := SaveRedemptionCode(model.RedemptionCode{
		ID:        "redeem-1",
		Code:      "ABC123",
		Name:      "test",
		Credits:   150,
		Status:    model.RedemptionCodeStatusEnabled,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("save redemption code: %v", err)
	}

	updated, redeemed, err := RedeemCode(code.Code, user.ID, model.CreditLog{ID: "credit-1", Remark: "兑换码充值"}, now)
	if err != nil {
		t.Fatalf("redeem code: %v", err)
	}
	if updated.Credits != 160 {
		t.Fatalf("credits = %d, want 160", updated.Credits)
	}
	if redeemed.ID != code.ID {
		t.Fatalf("redeemed id = %q, want %q", redeemed.ID, code.ID)
	}

	if _, _, err := RedeemCode(code.Code, user.ID, model.CreditLog{ID: "credit-2"}, now); err == nil {
		t.Fatal("second redeem succeeded, want error")
	}
	after, ok, err := GetUserByID(user.ID)
	if err != nil || !ok {
		t.Fatalf("get user after second redeem: ok=%v err=%v", ok, err)
	}
	if after.Credits != 160 {
		t.Fatalf("credits after second redeem = %d, want 160", after.Credits)
	}

	logs, total, _, err := ListCreditLogsByUser(user.ID, model.Query{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 1 || len(logs) != 1 {
		t.Fatalf("logs total=%d len=%d, want 1", total, len(logs))
	}
	if logs[0].Type != model.CreditLogTypeRedeemTopup || logs[0].Amount != 150 || logs[0].Balance != 160 || logs[0].RelatedID != code.ID {
		t.Fatalf("unexpected log: %#v", logs[0])
	}
}

func TestListCreditLogsByUserIsolatesUsers(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	for _, log := range []model.CreditLog{
		{ID: "credit-1", UserID: "user-1", Type: model.CreditLogTypeAIConsume, Amount: -10, Balance: 90, CreatedAt: now},
		{ID: "credit-2", UserID: "user-2", Type: model.CreditLogTypeAIConsume, Amount: -20, Balance: 80, CreatedAt: now},
	} {
		if _, err := SaveCreditLog(log); err != nil {
			t.Fatalf("save log: %v", err)
		}
	}
	logs, total, _, err := ListCreditLogsByUser("user-1", model.Query{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 1 || len(logs) != 1 || logs[0].UserID != "user-1" {
		t.Fatalf("logs=%#v total=%d, want only user-1", logs, total)
	}
}

func TestListCreditLogsSearchesUserProfile(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	if _, err := SaveUser(model.User{
		ID:          "user-1",
		Username:    "star-trail",
		DisplayName: "Star Trail",
		Email:       "star@example.com",
		Role:        model.UserRoleUser,
		Status:      model.UserStatusActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("save user: %v", err)
	}
	if _, err := SaveCreditLog(model.CreditLog{
		ID:        "credit-1",
		UserID:    "user-1",
		Type:      model.CreditLogTypeAIConsume,
		Amount:    -10,
		Balance:   90,
		CreatedAt: now,
	}); err != nil {
		t.Fatalf("save log: %v", err)
	}

	logs, total, _, err := ListCreditLogs(model.Query{Keyword: "Star Trail", Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 1 || len(logs) != 1 || logs[0].UserID != "user-1" {
		t.Fatalf("logs=%#v total=%d, want user-1 log", logs, total)
	}
}

func TestListCreditLogsFiltersTimeAndStats(t *testing.T) {
	setupRedemptionTestDB(t)
	logs := []model.CreditLog{
		{ID: "credit-old", UserID: "user-1", Type: model.CreditLogTypeAIConsume, Amount: -99, Balance: 901, CreatedAt: "2026-07-29T23:59:59+08:00"},
		{ID: "credit-1", UserID: "user-1", Type: model.CreditLogTypeAIConsume, Amount: -10, Balance: 890, Remark: "调用模型 gpt-image-2", CreatedAt: "2026-07-30T09:00:00+08:00"},
		{ID: "credit-2", UserID: "user-1", Type: model.CreditLogTypeAIRefund, Amount: 3, Balance: 893, Remark: "模型调用失败返还 gpt-image-2", CreatedAt: "2026-07-30T10:00:00+08:00"},
	}
	for _, log := range logs {
		if _, err := SaveCreditLog(log); err != nil {
			t.Fatalf("save log: %v", err)
		}
	}

	items, total, stats, err := ListCreditLogs(model.Query{
		Model:    "gpt-image-2",
		Start:    "2026-07-30T00:00:00+08:00",
		End:      "2026-07-30T23:59:59+08:00",
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 2 || len(items) != 2 {
		t.Fatalf("logs total=%d len=%d, want 2", total, len(items))
	}
	if stats.Consume != 10 || stats.Refund != 3 || stats.Net != -7 || stats.Count != 2 {
		t.Fatalf("stats=%#v, want consume=10 refund=3 net=-7 count=2", stats)
	}
}

func TestAdjustUserCreditsWritesAuditLog(t *testing.T) {
	setupRedemptionTestDB(t)
	now := "2026-07-30T20:00:00+08:00"
	if _, err := SaveUser(model.User{ID: "user-1", Username: "member", Credits: 100, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("save user: %v", err)
	}

	updated, ok, err := AdjustUserCredits("user-1", 135, model.CreditLog{
		ID:     "credit-adjust-1",
		Type:   model.CreditLogTypeAdminAdjust,
		Remark: "后台手动调整：活动补偿",
		Extra:  `{"operatorId":"admin-1","reason":"活动补偿"}`,
	}, now)
	if err != nil || !ok {
		t.Fatalf("adjust credits: ok=%v err=%v", ok, err)
	}
	if updated.Credits != 135 {
		t.Fatalf("credits = %d, want 135", updated.Credits)
	}
	logs, total, _, err := ListCreditLogsByUser("user-1", model.Query{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 1 || len(logs) != 1 || logs[0].Amount != 35 || logs[0].Balance != 135 || logs[0].Extra == "" {
		t.Fatalf("unexpected logs: %#v total=%d", logs, total)
	}
}

func TestAdjustUserCreditsRollsBackWhenAuditLogFails(t *testing.T) {
	setupRedemptionTestDB(t)
	now := "2026-07-30T20:00:00+08:00"
	if _, err := SaveUser(model.User{ID: "user-1", Username: "member", Credits: 100, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("save user: %v", err)
	}
	if _, err := SaveCreditLog(model.CreditLog{ID: "duplicate-log", UserID: "user-1", Type: model.CreditLogTypeAdminAdjust, CreatedAt: now}); err != nil {
		t.Fatalf("save existing log: %v", err)
	}

	if _, _, err := AdjustUserCredits("user-1", 200, model.CreditLog{ID: "duplicate-log", Type: model.CreditLogTypeAdminAdjust}, now); err == nil {
		t.Fatal("adjust credits succeeded, want duplicate log error")
	}
	user, ok, err := GetUserByID("user-1")
	if err != nil || !ok {
		t.Fatalf("get user: ok=%v err=%v", ok, err)
	}
	if user.Credits != 100 {
		t.Fatalf("credits = %d after rollback, want 100", user.Credits)
	}
}
