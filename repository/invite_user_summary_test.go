package repository

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestListInviteUserSummariesUsesTypedLogsAndIsolatesInvitation(t *testing.T) {
	setupRedemptionTestDB(t)
	users := []model.User{
		{ID: "invited", Username: "alice", Credits: 125, AffCode: "AFF-A", InviteRef: "ref-a", InviteSource: "invite_link", InviteTrialCredits: 50, CreatedAt: "2026-09-01T00:00:00Z", UpdatedAt: "2026-09-01T00:00:00Z"},
		{ID: "other", Username: "bob", Credits: 999, AffCode: "AFF-B", InviteRef: "ref-b", InviteSource: "invite_link", CreatedAt: "2026-09-01T00:00:00Z", UpdatedAt: "2026-09-01T00:00:00Z"},
	}
	for _, user := range users {
		if _, err := SaveUser(user); err != nil {
			t.Fatalf("save user: %v", err)
		}
	}
	logs := []model.CreditLog{
		{ID: "recharge-old", UserID: "invited", Type: model.CreditLogTypeRedeemTopup, Amount: 100, Balance: 100, CreatedAt: "2026-08-20T00:00:00Z"},
		{ID: "recharge", UserID: "invited", Type: model.CreditLogTypeRedeemTopup, Amount: 80, Balance: 180, CreatedAt: "2026-09-10T01:00:00Z"},
		{ID: "consume", UserID: "invited", Type: model.CreditLogTypeAIConsume, Amount: -30, Balance: 150, CreatedAt: "2026-09-11T01:00:00Z"},
		{ID: "refund", UserID: "invited", Type: model.CreditLogTypeAIRefund, Amount: 5, Balance: 155, CreatedAt: "2026-09-11T01:05:00Z"},
		{ID: "adjust", UserID: "invited", Type: model.CreditLogTypeAdminAdjust, Amount: -30, Balance: 125, CreatedAt: "2026-09-12T01:00:00Z"},
		{ID: "other-recharge", UserID: "other", Type: model.CreditLogTypeRedeemTopup, Amount: 999, Balance: 999, CreatedAt: "2026-09-10T01:00:00Z"},
	}
	for _, log := range logs {
		if _, err := SaveCreditLog(log); err != nil {
			t.Fatalf("save log: %v", err)
		}
	}

	rows, err := ListInviteUserSummaries("ref-a", "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z")
	if err != nil {
		t.Fatalf("list invitation summaries: %v", err)
	}
	if len(rows) != 1 || rows[0].ExternalUserID != "invited" {
		t.Fatalf("rows = %#v, want invited user only", rows)
	}
	row := rows[0]
	if row.CurrentBalance != 125 || row.TrialComputePointsGranted != 50 {
		t.Fatalf("balance/trial = %d/%d, want 125/50", row.CurrentBalance, row.TrialComputePointsGranted)
	}
	if row.PeriodRechargeAmount != 80 || row.PeriodRechargeCount != 1 || row.TotalRechargeAmount != 180 || row.TotalRechargeCount != 2 {
		t.Fatalf("recharge metrics = %#v", row)
	}
	if row.PeriodConsumeAmount != 30 || row.PeriodRefundAmount != 5 || row.PeriodNetConsumption != 25 || row.PeriodRequestCount != 1 {
		t.Fatalf("usage metrics = %#v", row)
	}
	if row.PeriodAdminAdjustment != -30 || row.LastRechargeAt != "2026-09-10T01:00:00Z" || row.LastActivityAt != "2026-09-11T01:05:00Z" {
		t.Fatalf("audit metrics = %#v", row)
	}
}
