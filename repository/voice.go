package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveClientAPIKey(key model.ClientAPIKey) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&key).Error
}

func ListClientAPIKeys(userID string) ([]model.ClientAPIKey, error) {
	db, err := DB()
	items := []model.ClientAPIKey{}
	if err != nil {
		return items, err
	}
	err = db.Where("user_id = ?", userID).Order("created_at DESC, id DESC").Find(&items).Error
	return items, err
}

func FindClientAPIKey(digest string) (model.ClientAPIKey, bool) {
	db, err := DB()
	var key model.ClientAPIKey
	if err != nil {
		return key, false
	}
	err = db.Where("digest = ? AND revoked_at = ?", digest, "").First(&key).Error
	return key, err == nil
}

func RevokeClientAPIKey(userID, id, at string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.ClientAPIKey{}).Where("id = ? AND user_id = ?", id, userID).Update("revoked_at", at)
	return result.RowsAffected > 0, result.Error
}

func SaveVoice(voice model.Voice) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&voice).Error
}

func GetVoice(userID, id string) (model.Voice, bool, error) {
	db, err := DB()
	var voice model.Voice
	if err != nil {
		return voice, false, err
	}
	err = db.Where("id = ? AND user_id = ?", id, userID).First(&voice).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return voice, false, nil
	}
	return voice, err == nil, err
}

func ListVoices(userID string, page, pageSize int) ([]model.Voice, int64, error) {
	db, err := DB()
	items := []model.Voice{}
	var total int64
	if err != nil {
		return items, total, err
	}
	query := db.Model(&model.Voice{}).Where("user_id = ? AND disabled_at = ?", userID, "")
	if err = query.Count(&total).Error; err != nil {
		return items, total, err
	}
	err = query.Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&items).Error
	return items, total, err
}

func UpdateVoice(userID, id string, changes map[string]any) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.Voice{}).Where("id = ? AND user_id = ? AND disabled_at = ?", id, userID, "").Updates(changes)
	return result.RowsAffected > 0, result.Error
}
