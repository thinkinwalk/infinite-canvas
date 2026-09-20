package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func TestInviteUserSummaryRangeParsesRFC3339(t *testing.T) {
	start, end, err := inviteUserSummaryRange("2026-09-01T00:00:00+08:00", "2026-09-20T23:59:59+08:00")
	if err != nil {
		t.Fatalf("inviteUserSummaryRange(): %v", err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-08-31T16:00:00Z" || end.UTC().Format(time.RFC3339) != "2026-09-20T15:59:59Z" {
		t.Fatalf("range = %s to %s", start, end)
	}
}

func TestInviteUserSummaryRangeRejectsIncompleteOrReversedRange(t *testing.T) {
	if _, _, err := inviteUserSummaryRange("2026-09-01T00:00:00Z", ""); err == nil {
		t.Fatal("inviteUserSummaryRange() accepted an incomplete range")
	}
	if _, _, err := inviteUserSummaryRange("2026-09-20T00:00:00Z", "2026-09-01T00:00:00Z"); err == nil {
		t.Fatal("inviteUserSummaryRange() accepted a reversed range")
	}
}

func TestInvitationTrialCreditsReadsValidatedGrant(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("ref"); got != "invite token" {
			t.Fatalf("ref = %q, want invite token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"agent_id":1,"trial_compute_points":50}`))
	}))
	defer server.Close()

	oldCfg := config.Cfg
	config.Cfg.InfiniteCanvasOpsURL = server.URL
	t.Cleanup(func() { config.Cfg = oldCfg })

	credits, err := invitationTrialCredits("invite token")
	if err != nil || credits != 50 {
		t.Fatalf("invitationTrialCredits() = %d, %v; want 50, nil", credits, err)
	}
}

func TestInvitationTrialCreditsRejectsGrantAboveMaximum(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"trial_compute_points":101}`))
	}))
	defer server.Close()

	oldCfg := config.Cfg
	config.Cfg.InfiniteCanvasOpsURL = server.URL
	t.Cleanup(func() { config.Cfg = oldCfg })

	if _, err := invitationTrialCredits("ref"); err == nil {
		t.Fatal("invitationTrialCredits() accepted more than 100 credits")
	}
}

func TestInvitationTrialCreditsRejectsInvalidInvitation(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	oldCfg := config.Cfg
	config.Cfg.InfiniteCanvasOpsURL = server.URL
	t.Cleanup(func() { config.Cfg = oldCfg })

	if _, err := invitationTrialCredits("expired"); err == nil {
		t.Fatal("invitationTrialCredits() accepted an invalid invitation")
	}
}

func TestRegistrationCallbackReportsGrantedTrialCredits(t *testing.T) {
	var payload registrationCallbackPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode callback: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	oldCfg := config.Cfg
	config.Cfg.InfiniteCanvasOpsURL = server.URL
	config.Cfg.InfiniteCanvasCallbackSecret = "callback-secret"
	t.Cleanup(func() { config.Cfg = oldCfg })

	user := model.User{ID: "user-invite", Username: "invitee", InviteTrialCredits: 50}
	if err := notifyCanvasRegistration(user, "ref-token"); err != nil {
		t.Fatalf("notifyCanvasRegistration(): %v", err)
	}
	if payload.ExternalUserID != user.ID || payload.Ref != "ref-token" || payload.TrialComputePointsGranted != 50 {
		t.Fatalf("unexpected callback payload: %+v", payload)
	}
}
