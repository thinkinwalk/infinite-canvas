package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ClientKeyDigest(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func CreateClientAPIKey(userID, name string) (model.ClientAPIKey, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.ClientAPIKey{}, "", fmt.Errorf("请输入客户端名称")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return model.ClientAPIKey{}, "", err
	}
	secret := "icv_" + base64.RawURLEncoding.EncodeToString(random)
	key := model.ClientAPIKey{ID: newID("key"), UserID: userID, Name: name, Prefix: secret[:12], Digest: ClientKeyDigest(secret), CreatedAt: now()}
	return key, secret, repository.SaveClientAPIKey(key)
}

func ClientAPIKeyUser(secret string) (model.AuthUser, bool) {
	if !strings.HasPrefix(secret, "icv_") {
		return model.AuthUser{}, false
	}
	key, found := repository.FindClientAPIKey(ClientKeyDigest(secret))
	if !found {
		return model.AuthUser{}, false
	}
	user, found, err := repository.GetUserByID(key.UserID)
	if err != nil || !found || user.Status == model.UserStatusBan || user.Role != model.UserRoleUser {
		return model.AuthUser{}, false
	}
	return model.PublicUser(user), true
}
