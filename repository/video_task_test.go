package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestRefundFailedVideoTaskRefundsOnlyOnce(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	user, err := SaveUser(model.User{
		ID: "user-video", Username: "video-user", Role: model.UserRoleUser,
		Credits: 800, Status: model.UserStatusActive, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("save user: %v", err)
	}
	task := model.VideoTask{
		ID: "task-video", UserID: user.ID, Model: "video-model", Credits: 200,
		Path: "/videos", Status: "running", CreatedAt: now, UpdatedAt: now,
	}
	if err := SaveVideoTask(task); err != nil {
		t.Fatalf("save video task: %v", err)
	}

	refunded, err := RefundFailedVideoTask(task.ID, user.ID, "failed", model.CreditLog{ID: "credit-refund-1"}, now)
	if err != nil || !refunded {
		t.Fatalf("first refund: refunded=%v err=%v", refunded, err)
	}
	refunded, err = RefundFailedVideoTask(task.ID, user.ID, "failed", model.CreditLog{ID: "credit-refund-2"}, now)
	if err != nil || refunded {
		t.Fatalf("second refund: refunded=%v err=%v", refunded, err)
	}

	updated, ok, err := GetUserByID(user.ID)
	if err != nil || !ok || updated.Credits != 1000 {
		t.Fatalf("user after refunds: user=%#v ok=%v err=%v", updated, ok, err)
	}
	logs, total, _, err := ListCreditLogsByUser(user.ID, model.Query{Page: 1, PageSize: 20})
	if err != nil || total != 1 || len(logs) != 1 {
		t.Fatalf("refund logs: total=%d len=%d err=%v", total, len(logs), err)
	}
	if logs[0].Amount != 200 || logs[0].Balance != 1000 || logs[0].RelatedID != task.ID {
		t.Fatalf("unexpected refund log: %#v", logs[0])
	}
	saved, ok, err := GetVideoTask(task.ID)
	if err != nil || !ok || !saved.Refunded || saved.Status != "failed" {
		t.Fatalf("saved task: task=%#v ok=%v err=%v", saved, ok, err)
	}
}

func TestNonFailedVideoTaskStatusesDoNotRefund(t *testing.T) {
	setupRedemptionTestDB(t)
	now := time.Now().Format(time.RFC3339)
	if err := SaveVideoTask(model.VideoTask{ID: "task-running", UserID: "user-video", Credits: 200, Status: "pending", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("save video task: %v", err)
	}
	for _, status := range []string{"running", "completed"} {
		if err := UpdateVideoTaskStatus("task-running", "user-video", status, now); err != nil {
			t.Fatalf("update video task to %s: %v", status, err)
		}
	}
	saved, ok, err := GetVideoTask("task-running")
	if err != nil || !ok || saved.Status != "completed" || saved.Refunded {
		t.Fatalf("saved task: task=%#v ok=%v err=%v", saved, ok, err)
	}
}
