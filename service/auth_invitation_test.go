package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

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
