package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestAdminClientAPIKeysHTTP(t *testing.T) {
	oldConfig := config.Cfg
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: "file:admin-key-http-test?mode=memory&cache=shared", JWTSecret: "admin-key-test"}
	t.Cleanup(func() { config.Cfg = oldConfig })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	t.Cleanup(func() {
		db.Where("user_id IN ?", ids).Delete(&model.ClientAPIKey{})
		db.Where("id IN ?", ids).Delete(&model.User{})
	})
	newUser := func(role model.UserRole) (model.User, string) {
		t.Helper()
		id := uuid.NewString()
		user := model.User{ID: id, Username: id, AffCode: id, Role: role, Status: model.UserStatusActive, Group: "default", Credits: 123}
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{
			UserID: id, Username: id, Role: role,
			RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
		}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		return user, token
	}
	admin, adminToken := newUser(model.UserRoleAdmin)
	user, userToken := newUser(model.UserRoleUser)
	other, _ := newUser(model.UserRoleUser)
	server := httptest.NewServer(New())
	defer server.Close()
	type response struct {
		Code  int             `json:"code"`
		Data  json.RawMessage `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	call := func(method, path, token string, payload any) (int, response) {
		t.Helper()
		body, _ := json.Marshal(payload)
		req, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var result response
		if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
			t.Fatal("invalid API response")
		}
		if method == "POST" && result.Code == 0 && res.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatal("key creation must not be cached")
		}
		return res.StatusCode, result
	}
	expectError := func(method, path, token string, payload any, expected int, code string) {
		t.Helper()
		status, result := call(method, path, token, payload)
		if status != expected || result.Code == 0 || result.Error.Code != code {
			t.Fatalf("%s: status %d, error %s; want %d %s", method, status, result.Error.Code, expected, code)
		}
	}
	path := "/api/admin/users/" + user.ID + "/client-api-keys"
	otherPath := "/api/admin/users/" + other.ID + "/client-api-keys"
	name := map[string]string{"name": "admin-created desktop client"}
	status, result := call("POST", path, adminToken, name)
	if status != 200 || result.Code != 0 {
		t.Fatal("administrator could not create a user key")
	}
	var created struct {
		Key    model.ClientAPIKey `json:"key"`
		Secret string             `json:"api_key"`
	}
	_ = json.Unmarshal(result.Data, &created)
	if created.Secret == "" || created.Key.ID == "" {
		t.Fatal("missing one-time key")
	}
	var stored model.ClientAPIKey
	if err := db.First(&stored, "id = ?", created.Key.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.UserID != user.ID || stored.Digest != service.ClientKeyDigest(created.Secret) {
		t.Fatal("administrator-created key has incorrect owner or digest")
	}
	auth, ok := service.ClientAPIKeyUser(created.Secret)
	if !ok || auth.ID != user.ID || auth.Role != model.UserRoleUser || auth.Credits != 123 {
		t.Fatal("client key did not retain its ordinary account permissions and balance")
	}
	for _, listing := range []struct{ path, token string }{{path, adminToken}, {"/api/client-api-keys", userToken}} {
		status, result = call("GET", listing.path, listing.token, nil)
		var list struct {
			Items []model.ClientAPIKey `json:"items"`
		}
		_ = json.Unmarshal(result.Data, &list)
		if status != 200 || result.Code != 0 || len(list.Items) != 1 || list.Items[0].ID != created.Key.ID ||
			bytes.Contains(result.Data, []byte(created.Secret)) || bytes.Contains(result.Data, []byte("digest")) {
			t.Fatal("key list leaked a secret or did not use the selected owner")
		}
	}
	for _, token := range []string{"", userToken, created.Secret} {
		for _, method := range []string{"GET", "POST", "DELETE"} {
			target := path
			if method == "DELETE" {
				target += "/" + created.Key.ID
			}
			_, denied := call(method, target, token, name)
			if denied.Code == 0 {
				t.Fatal("non-administrator could access administrator key management")
			}
		}
	}
	expectError("POST", "/api/client-api-keys", created.Secret, name, 401, "SESSION_REQUIRED")
	expectError("POST", "/api/client-api-keys", adminToken, name, 401, "SESSION_REQUIRED")
	expectError("GET", "/api/v1/voices", adminToken, nil, 401, "UNAUTHORIZED")
	status, result = call("GET", "/api/v1/voices", created.Secret, nil)
	if status != 200 || result.Code != 0 {
		t.Fatal("ordinary owner client key cannot access voice API")
	}
	expectError("DELETE", otherPath+"/"+created.Key.ID, adminToken, nil, 404, "KEY_NOT_FOUND")
	expectError("DELETE", "/api/client-api-keys/"+created.Key.ID, "", nil, 401, "SESSION_REQUIRED")
	expectError("POST", "/api/admin/users/"+admin.ID+"/client-api-keys", adminToken, name, 400, "INVALID_KEY_OWNER")
	expectError("POST", "/api/admin/users/missing-user/client-api-keys", adminToken, name, 404, "USER_NOT_FOUND")
	expectError("POST", path, adminToken, map[string]string{"name": "client", "user_id": other.ID}, 400, "INVALID_REQUEST")
	if err := db.Model(&user).Update("status", model.UserStatusBan).Error; err != nil {
		t.Fatal(err)
	}
	expectError("POST", path, adminToken, name, 409, "ACCOUNT_DISABLED")
	expectError("GET", "/api/v1/voices", created.Secret, nil, 401, "UNAUTHORIZED")
	// Banned or promoted owners' historical keys must remain visible and revocable.
	if err := db.Model(&user).Update("role", model.UserRoleAdmin).Error; err != nil {
		t.Fatal(err)
	}
	status, result = call("GET", path, adminToken, nil)
	if status != 200 || result.Code != 0 {
		t.Fatal("administrator cannot inspect historical keys of a changed owner")
	}
	status, result = call("DELETE", path+"/"+created.Key.ID, adminToken, nil)
	if status != 200 || result.Code != 0 {
		t.Fatal("administrator cannot revoke a banned or promoted owner's key")
	}
	if err := db.Model(&user).Updates(map[string]any{"role": model.UserRoleUser, "status": model.UserStatusActive}).Error; err != nil {
		t.Fatal(err)
	}
	expectError("GET", "/api/v1/voices", created.Secret, nil, 401, "UNAUTHORIZED")
	for _, id := range ids {
		var account model.User
		db.First(&account, "id = ?", id)
		if account.Credits != 123 {
			t.Fatal("key management changed an account balance")
		}
	}
}
