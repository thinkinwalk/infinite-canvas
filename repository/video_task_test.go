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
	if err := SaveVideoTask(task, ""); err != nil {
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
	if err := SaveVideoTask(model.VideoTask{ID: "task-running", UserID: "user-video", Credits: 200, Status: "pending", CreatedAt: now, UpdatedAt: now}, ""); err != nil {
		t.Fatalf("save video task: %v", err)
	}
	for _, status := range []string{"running", "completed"} {
		if err := UpdateVideoTaskStatus("task-running", "user-video", status, now, ""); err != nil {
			t.Fatalf("update video task to %s: %v", status, err)
		}
	}
	saved, ok, err := GetVideoTask("task-running")
	if err != nil || !ok || saved.Status != "completed" || saved.Refunded {
		t.Fatalf("saved task: task=%#v ok=%v err=%v", saved, ok, err)
	}
}

func TestSaveVideoTaskLinksOnlyMatchingDebitAndRollsBack(t *testing.T) {
	setupRedemptionTestDB(t)
	entries := []model.CreditLog{
		{ID: "video-debit", UserID: "owner", Type: model.CreditLogTypeAIConsume},
		{ID: "other-debit", UserID: "other", Type: model.CreditLogTypeAIConsume},
		{ID: "video-refund", UserID: "owner", Type: model.CreditLogTypeAIRefund},
	}
	for _, entry := range entries {
		if _, err := SaveCreditLog(entry); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"other-debit", "video-refund", "missing-debit"} {
		task := model.VideoTask{ID: "task-" + id, UserID: "owner"}
		if err := SaveVideoTask(task, id); err == nil {
			t.Fatalf("linked invalid debit %s", id)
		}
		if _, found, err := GetVideoTask(task.ID); err != nil || found {
			t.Fatalf("failed transaction left task: found=%v err=%v", found, err)
		}
	}
	task := model.VideoTask{ID: "linked-video", UserID: "owner", Status: "running"}
	if err := SaveVideoTask(task, "video-debit"); err != nil {
		t.Fatal(err)
	}
	entry, found, err := GetCreditLog("video-debit")
	if err != nil || !found || entry.RelatedID != task.ID {
		t.Fatalf("debit not linked: %#v err=%v", entry, err)
	}
	if err := UpdateVideoTaskStatus(task.ID, task.UserID, "completed", "now", "https://cdn.example/video.mp4"); err != nil {
		t.Fatal(err)
	}
	if err := UpdateVideoTaskStatus(task.ID, task.UserID, "completed", "later", ""); err != nil {
		t.Fatal(err)
	}
	saved, _, err := GetVideoTask(task.ID)
	if err != nil || saved.OutputURL != "https://cdn.example/video.mp4" {
		t.Fatalf("result URL was lost: %#v err=%v", saved, err)
	}
}
