package repository

import (
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrReplicateCredits = errors.New("算力点不足")

func GetReplicateTask(id string) (model.ReplicateTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.ReplicateTask{}, false, err
	}
	var task model.ReplicateTask
	err = db.Where("id = ?", id).First(&task).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return task, false, nil
	}
	return task, err == nil, err
}

// The task ID is the idempotency key. Insert, debit and ledger commit together.
func CreateReplicateTask(task model.ReplicateTask, log model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&task).Error; err != nil {
			return err
		}
		if task.Credits <= 0 {
			return nil
		}
		debit := tx.Model(&model.User{}).Where("id = ? AND credits >= ?", task.UserID, task.Credits).Updates(map[string]any{"credits": gorm.Expr("credits - ?", task.Credits), "updated_at": task.CreatedAt})
		if debit.Error != nil {
			return debit.Error
		}
		if debit.RowsAffected == 0 {
			return ErrReplicateCredits
		}
		var user model.User
		if err := tx.Where("id = ?", task.UserID).First(&user).Error; err != nil {
			return err
		}
		log.UserID = task.UserID
		log.Amount = -task.Credits
		log.Balance = user.Credits
		log.Type = model.CreditLogTypeAIConsume
		log.RelatedID = task.ID
		log.CreatedAt = task.CreatedAt
		return tx.Create(&log).Error
	})
}

func replicateProviderKey(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func UpdateReplicateTask(task model.ReplicateTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	query := db.Model(&model.ReplicateTask{}).Where("id = ? AND user_id = ? AND refunded = ? AND status NOT IN ?", task.ID, task.UserID, false, []string{"completed", "failed", "cancelled"})
	if task.Status == "running" || task.Status == "uncertain" {
		query = query.Where("status <> ?", "generated")
	}
	return query.Updates(map[string]any{"prediction_id": task.PredictionID, "provider_key": replicateProviderKey(task.PredictionID), "status": task.Status, "output_url": task.OutputURL, "result_file": task.ResultFile, "result_json": task.ResultJSON, "mime_type": task.MimeType, "error": task.Error, "metrics": task.Metrics, "pricing_snapshot": task.PricingSnapshot, "updated_at": task.UpdatedAt}).Error
}

func FailReplicateTask(task model.ReplicateTask, log model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&model.ReplicateTask{}).Where("id = ? AND user_id = ? AND refunded = ? AND status NOT IN ?", task.ID, task.UserID, false, []string{"completed", "generated", "failed", "cancelled"}).Updates(map[string]any{"status": task.Status, "error": task.Error, "refunded": true, "updated_at": task.UpdatedAt, "prediction_id": task.PredictionID, "provider_key": replicateProviderKey(task.PredictionID)})
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 || task.Credits <= 0 {
			return nil
		}
		if err := tx.Model(&model.User{}).Where("id = ?", task.UserID).Updates(map[string]any{"credits": gorm.Expr("credits + ?", task.Credits), "updated_at": task.UpdatedAt}).Error; err != nil {
			return err
		}
		var user model.User
		if err := tx.Where("id = ?", task.UserID).First(&user).Error; err != nil {
			return err
		}
		log.UserID = task.UserID
		log.Type = model.CreditLogTypeAIRefund
		log.Amount = task.Credits
		log.Balance = user.Credits
		log.RelatedID = task.ID
		log.CreatedAt = task.UpdatedAt
		return tx.Create(&log).Error
	})
}

func SaveReferenceMediaOwner(item model.ReferenceMediaOwner) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&item).Error
}
func GetReferenceMediaOwner(id string) (model.ReferenceMediaOwner, bool, error) {
	db, err := DB()
	if err != nil {
		return model.ReferenceMediaOwner{}, false, err
	}
	var item model.ReferenceMediaOwner
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return item, false, nil
	}
	return item, err == nil, err
}

// Attach only a verified provider prediction to an unresolved submission.
func AttachReplicatePrediction(id, predictionID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.ReplicateTask{}).Where("prediction_id = ? AND id <> ?", predictionID, id).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return errors.New("该上游任务已关联其他任务")
		}
		result := tx.Model(&model.ReplicateTask{}).Where("id = ? AND status = ? AND prediction_id = ? AND refunded = ?", id, "uncertain", "", false).Updates(map[string]any{"prediction_id": predictionID, "provider_key": predictionID})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("任务状态已变化，请重新查询")
		}
		return nil
	})
}
