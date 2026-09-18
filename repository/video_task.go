package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveVideoTask(task model.VideoTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&task).Error
}

func GetVideoTask(id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.Where("id = ?", id).First(&task).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.VideoTask{}, false, nil
	}
	return task, err == nil, err
}

func UpdateVideoTaskStatus(id string, userID string, status string, now string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.VideoTask{}).Where("id = ? AND user_id = ?", id, userID).Updates(map[string]any{"status": status, "updated_at": now}).Error
}

// RefundFailedVideoTask atomically claims the one-time refund, updates the balance, and writes its audit log.
func RefundFailedVideoTask(id string, userID string, status string, log model.CreditLog, now string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	refunded := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var task model.VideoTask
		if err := tx.Where("id = ? AND user_id = ?", id, userID).First(&task).Error; err != nil {
			return err
		}
		claim := tx.Model(&model.VideoTask{}).
			Where("id = ? AND user_id = ? AND refunded = ?", id, userID, false).
			Updates(map[string]any{"status": status, "refunded": true, "updated_at": now})
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 || task.Credits <= 0 {
			return nil
		}
		if err := tx.Model(&model.User{}).Where("id = ?", userID).Updates(map[string]any{
			"credits":    gorm.Expr("credits + ?", task.Credits),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		var user model.User
		if err := tx.Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}
		log.UserID = userID
		log.Type = model.CreditLogTypeAIRefund
		log.Amount = task.Credits
		log.Balance = user.Credits
		log.RelatedID = task.ID
		log.CreatedAt = now
		if err := tx.Create(&log).Error; err != nil {
			return err
		}
		refunded = true
		return nil
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return refunded, err
}
