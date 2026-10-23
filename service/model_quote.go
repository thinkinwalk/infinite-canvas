package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
)

type ManagedQuoteProof struct {
	Group      string `json:"group"`
	UserID     string `json:"user"`
	FeatureID  string `json:"feature"`
	ModelID    string `json:"model"`
	ChannelID  int    `json:"channel"`
	Revision   int    `json:"revision"`
	Parameters string `json:"parameters"`
}

func ManagedParameterHash(parameters any) string {
	data, _ := json.Marshal(parameters)
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func SignManagedQuote(userID string, selected *ManagedSelection, parameters any) string {
	proof := ManagedQuoteProof{Group: selected.Group, UserID: userID, FeatureID: selected.Feature.ID, ModelID: selected.Model.ID, ChannelID: selected.Channel.ID, Revision: selected.Revision, Parameters: ManagedParameterHash(parameters)}
	data, _ := json.Marshal(proof)
	payload := base64.RawURLEncoding.EncodeToString(data)
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func VerifyManagedQuote(token, userID string, parameters any) (ManagedQuoteProof, error) {
	var proof ManagedQuoteProof
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return proof, fmt.Errorf("请重新读取并确认模型报价")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return proof, fmt.Errorf("报价凭据无效")
	}
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return proof, fmt.Errorf("报价凭据无效")
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(data, &proof) != nil || proof.UserID != userID || proof.Parameters != ManagedParameterHash(parameters) {
		return proof, fmt.Errorf("报价参数已变化，请重新确认费用")
	}
	return proof, nil
}
