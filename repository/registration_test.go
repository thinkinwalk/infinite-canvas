package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestCreateRegisteredUserWritesInvitationGrantAtomically(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	user := model.User{
		ID: "invite-user", Username: "invitee", Role: model.UserRoleUser,
		Credits: 50, InviteTrialCredits: 50, Status: model.UserStatusActive,
		CreatedAt: now, UpdatedAt: now,
	}
	created, err := CreateRegisteredUser(user, &model.CreditLog{
		ID: "invite-log", Type: model.CreditLogTypeInviteTrial,
		RelatedID: user.ID, Remark: "邀请注册赠送算力点",
	})
	if err != nil {
		t.Fatalf("create registered user: %v", err)
	}
	if created.Credits != 50 || created.InviteTrialCredits != 50 {
		t.Fatalf("created user credits = %d/%d, want 50/50", created.Credits, created.InviteTrialCredits)
	}
	logs, total, _, err := ListCreditLogsByUser(user.ID, model.Query{Page: 1, PageSize: 10})
	if err != nil || total != 1 || len(logs) != 1 {
		t.Fatalf("invitation logs = %d/%d, %v; want 1/1, nil", total, len(logs), err)
	}
	if logs[0].Type != model.CreditLogTypeInviteTrial || logs[0].Amount != 50 || logs[0].Balance != 50 {
		t.Fatalf("unexpected invitation log: %+v", logs[0])
	}
}

func TestCreateRegisteredUserRollsBackWhenInvitationLogFails(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	if _, err := SaveCreditLog(model.CreditLog{ID: "duplicate-log", UserID: "other", CreatedAt: now}); err != nil {
		t.Fatalf("seed duplicate log: %v", err)
	}
	user := model.User{ID: "rolled-back-user", Username: "rollback", Credits: 50, InviteTrialCredits: 50, CreatedAt: now, UpdatedAt: now}
	if _, err := CreateRegisteredUser(user, &model.CreditLog{ID: "duplicate-log", Type: model.CreditLogTypeInviteTrial}); err == nil {
		t.Fatal("CreateRegisteredUser() succeeded with a duplicate log ID")
	}
	if _, ok, err := GetUserByID(user.ID); err != nil || ok {
		t.Fatalf("rolled-back user exists: ok=%v err=%v", ok, err)
	}
}
