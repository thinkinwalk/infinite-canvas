package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type opsResponse struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
}

func TestOpsRedemptionTokenAccessAndIsolation(t *testing.T) {
	oldConfig := config.Cfg
	config.Cfg = config.Config{
		StorageDriver:      "sqlite",
		DatabaseDSN:        "file:ops-redemption-test?mode=memory&cache=shared",
		JWTSecret:          "test-jwt-secret",
		JWTExpireHours:     1,
		OpsRedemptionToken: "ops-test-token",
		StaticDir:          t.TempDir(),
	}
	t.Cleanup(func() { config.Cfg = oldConfig })

	if _, err := service.SaveUser(model.User{ID: "admin-1", Username: "ops-test-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive}, "admin-password"); err != nil {
		t.Fatalf("create test administrator: %v", err)
	}
	router := New()
	request := func(method, path, token string, body string) opsResponse {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		if token != "" {
			req.Header.Set("X-Internal-Redemption-Token", token)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var response opsResponse
		if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode %s %s response: %v; body=%s", method, path, err, res.Body.String())
		}
		return response
	}

	t.Run("unconfigured token is disabled", func(t *testing.T) {
		config.Cfg.OpsRedemptionToken = ""
		response := request(http.MethodGet, "/api/admin/redemption-codes?page=1&pageSize=1", "ops-test-token", "")
		if response.Code != 1 || response.Msg != "未登录或权限不足" {
			t.Fatalf("response=%+v, want existing unauthorized response", response)
		}
		config.Cfg.OpsRedemptionToken = "ops-test-token"
	})

	for _, test := range []struct {
		name  string
		token string
	}{
		{name: "missing token"},
		{name: "wrong token", token: "wrong-token"},
		{name: "length mismatch", token: "ops-test-token-extra"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := request(http.MethodGet, "/api/admin/redemption-codes?page=1&pageSize=1", test.token, "")
			if response.Code != 1 || response.Msg != "未登录或权限不足" {
				t.Fatalf("response=%+v, want existing unauthorized response", response)
			}
		})
	}

	list := request(http.MethodGet, "/api/admin/redemption-codes?page=1&pageSize=1", "ops-test-token", "")
	if list.Code != 0 {
		t.Fatalf("internal list response=%+v", list)
	}

	created := request(http.MethodPost, "/api/admin/redemption-codes", "ops-test-token", `{"name":"local-test","credits":100,"count":1,"expiresAt":"","remark":"test"}`)
	if created.Code != 0 {
		t.Fatalf("internal create response=%+v", created)
	}
	var codes []model.RedemptionCode
	if err := json.Unmarshal(created.Data, &codes); err != nil || len(codes) != 1 {
		t.Fatalf("created data=%s err=%v", created.Data, err)
	}
	if codes[0].CreatedBy != "ops-integration" {
		t.Fatalf("createdBy=%q, want ops-integration", codes[0].CreatedBy)
	}

	updated := request(http.MethodPost, "/api/admin/redemption-codes/"+codes[0].ID+"/status", "ops-test-token", `{"status":"disabled"}`)
	if updated.Code != 0 {
		t.Fatalf("internal status response=%+v", updated)
	}
	var updatedCode model.RedemptionCode
	if err := json.Unmarshal(updated.Data, &updatedCode); err != nil || updatedCode.Status != model.RedemptionCodeStatusDisabled {
		t.Fatalf("updated data=%s err=%v", updated.Data, err)
	}

	for _, path := range []string{"/api/admin/users?page=1&pageSize=1", "/api/admin/settings"} {
		t.Run("token cannot access "+path, func(t *testing.T) {
			response := request(http.MethodGet, path, "ops-test-token", "")
			if response.Code != 1 || response.Msg != "未登录或权限不足" {
				t.Fatalf("response=%+v, want existing unauthorized response", response)
			}
		})
	}

	login := request(http.MethodPost, "/api/admin/login", "", `{"username":"ops-test-admin","password":"admin-password"}`)
	if login.Code != 0 {
		t.Fatalf("admin login response=%+v", login)
	}
	var session model.AuthSession
	if err := json.Unmarshal(login.Data, &session); err != nil || session.Token == "" {
		t.Fatalf("login data=%s err=%v", login.Data, err)
	}
	adminListReq := httptest.NewRequest(http.MethodGet, "/api/admin/redemption-codes?page=1&pageSize=1", nil)
	adminListReq.Header.Set("Authorization", "Bearer "+session.Token)
	adminListRes := httptest.NewRecorder()
	router.ServeHTTP(adminListRes, adminListReq)
	var adminList opsResponse
	if err := json.Unmarshal(adminListRes.Body.Bytes(), &adminList); err != nil || adminList.Code != 0 {
		t.Fatalf("admin redemption list response=%s err=%v", adminListRes.Body.String(), err)
	}
}
