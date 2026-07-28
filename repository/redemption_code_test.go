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

	logs, total, err := ListCreditLogsByUser(user.ID, model.Query{Page: 1, PageSize: 20})
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
	logs, total, err := ListCreditLogsByUser("user-1", model.Query{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list logs: %v", err)
	}
	if total != 1 || len(logs) != 1 || logs[0].UserID != "user-1" {
		t.Fatalf("logs=%#v total=%d, want only user-1", logs, total)
	}
}
