package repository

import (
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListUsers 分页查询用户。
func ListUsers(q model.Query) ([]model.User, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.User{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ? OR linux_do_id LIKE ?", like, like, like, like)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var users []model.User
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&users).Error
	return users, total, err
}

// CountUsers 返回用户总数。
func CountUsers() (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var total int64
	return total, db.Model(&model.User{}).Count(&total).Error
}

// HasAdmin 判断系统中是否存在管理员。
func HasAdmin() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var total int64
	err = db.Model(&model.User{}).Where("role = ?", model.UserRoleAdmin).Count(&total).Error
	return total > 0, err
}

// GetUserByID 根据 ID 查询用户。
func GetUserByID(id string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "id = ?", id)
}

// GetUserByUsername 根据用户名查询用户。
func GetUserByUsername(username string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "username = ?", username)
}

// SaveUser 保存用户信息。
func SaveUser(user model.User) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	return user, db.Save(&user).Error
}

func ConsumeUserCredits(id string, credits int, now string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	if credits <= 0 {
		user, ok, err := GetUserByID(id)
		return user, ok, err
	}
	tx := db.Model(&model.User{}).Where("id = ? AND credits >= ?", id, credits).Updates(map[string]any{
		"credits":    gorm.Expr("credits - ?", credits),
		"updated_at": now,
	})
	if tx.Error != nil {
		return model.User{}, false, tx.Error
	}
	user, ok, err := GetUserByID(id)
	return user, ok && tx.RowsAffected > 0, err
}

func RefundUserCredits(id string, credits int, now string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	if credits <= 0 {
		user, ok, err := GetUserByID(id)
		return user, ok, err
	}
	tx := db.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
		"credits":    gorm.Expr("credits + ?", credits),
		"updated_at": now,
	})
	if tx.Error != nil {
		return model.User{}, false, tx.Error
	}
	user, ok, err := GetUserByID(id)
	return user, ok && tx.RowsAffected > 0, err
}

// SaveCreditLog 保存算力点变更流水。
func SaveCreditLog(log model.CreditLog) (model.CreditLog, error) {
	db, err := DB()
	if err != nil {
		return log, err
	}
	return log, db.Save(&log).Error
}

func ListCreditLogs(q model.Query) ([]model.CreditLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CreditLog{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("user_id LIKE ? OR type LIKE ? OR remark LIKE ? OR related_id LIKE ?", like, like, like, like)
	}
	if logType := strings.TrimSpace(q.Type); logType != "" {
		tx = tx.Where("type = ?", logType)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.CreditLog
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&logs).Error
	return logs, total, err
}

func ListCreditLogsByUser(userID string, q model.Query) ([]model.CreditLog, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CreditLog{}).Where("user_id = ?", userID)
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("type LIKE ? OR remark LIKE ? OR related_id LIKE ?", like, like, like)
	}
	if logType := strings.TrimSpace(q.Type); logType != "" {
		tx = tx.Where("type = ?", logType)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.CreditLog
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&logs).Error
	return logs, total, err
}

func DeleteCreditLog(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.CreditLog{}, "id = ?", id).Error
}

func SaveRedemptionCode(code model.RedemptionCode) (model.RedemptionCode, error) {
	db, err := DB()
	if err != nil {
		return code, err
	}
	return code, db.Save(&code).Error
}

func ListRedemptionCodes(q model.Query) ([]model.RedemptionCode, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.RedemptionCode{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("code LIKE ? OR name LIKE ? OR created_by LIKE ? OR used_by LIKE ? OR remark LIKE ?", like, like, like, like, like)
	}
	if status := strings.TrimSpace(q.Type); status != "" {
		now := time.Now().Format(time.RFC3339)
		switch status {
		case "expired":
			tx = tx.Where("status = ? AND expires_at <> '' AND expires_at < ?", model.RedemptionCodeStatusEnabled, now)
		case string(model.RedemptionCodeStatusEnabled):
			tx = tx.Where("status = ? AND (expires_at = '' OR expires_at >= ?)", model.RedemptionCodeStatusEnabled, now)
		case string(model.RedemptionCodeStatusDisabled), string(model.RedemptionCodeStatusUsed):
			tx = tx.Where("status = ?", status)
		}
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var codes []model.RedemptionCode
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&codes).Error
	return codes, total, err
}

func UpdateRedemptionCodeStatus(id string, status model.RedemptionCodeStatus, now string) (model.RedemptionCode, error) {
	db, err := DB()
	if err != nil {
		return model.RedemptionCode{}, err
	}
	var code model.RedemptionCode
	if err := db.Where("id = ?", id).First(&code).Error; err != nil {
		return model.RedemptionCode{}, err
	}
	if code.Status == model.RedemptionCodeStatusUsed {
		return code, errors.New("已使用的兑换码不能修改状态")
	}
	if err := db.Model(&model.RedemptionCode{}).Where("id = ?", id).Updates(map[string]any{
		"status":     status,
		"updated_at": now,
	}).Error; err != nil {
		return model.RedemptionCode{}, err
	}
	err = db.Where("id = ?", id).First(&code).Error
	return code, err
}

func DeleteRedemptionCode(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.RedemptionCode{}, "id = ?", id).Error
}

func DeleteInvalidRedemptionCodes(now string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	result := db.Where("status IN ? OR (status = ? AND expires_at <> '' AND expires_at < ?)", []model.RedemptionCodeStatus{model.RedemptionCodeStatusUsed, model.RedemptionCodeStatusDisabled}, model.RedemptionCodeStatusEnabled, now).Delete(&model.RedemptionCode{})
	return result.RowsAffected, result.Error
}

func RedeemCode(code string, userID string, log model.CreditLog, now string) (model.User, model.RedemptionCode, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, model.RedemptionCode{}, err
	}
	var user model.User
	var redemption model.RedemptionCode
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("code = ?", code).First(&redemption).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("无效的兑换码")
			}
			return err
		}
		if redemption.Status != model.RedemptionCodeStatusEnabled {
			return errors.New("该兑换码不可用")
		}
		if redemption.ExpiresAt != "" && redemption.ExpiresAt < now {
			return errors.New("该兑换码已过期")
		}
		result := tx.Model(&model.RedemptionCode{}).
			Where("id = ? AND status = ?", redemption.ID, model.RedemptionCodeStatusEnabled).
			Updates(map[string]any{
				"status":     model.RedemptionCodeStatusUsed,
				"used_by":    userID,
				"used_at":    now,
				"updated_at": now,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return errors.New("该兑换码已被使用")
		}
		if err := tx.Model(&model.User{}).Where("id = ?", userID).Updates(map[string]any{
			"credits":    gorm.Expr("credits + ?", redemption.Credits),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}
		log.UserID = userID
		log.Type = model.CreditLogTypeRedeemTopup
		log.Amount = redemption.Credits
		log.Balance = user.Credits
		log.RelatedID = redemption.ID
		log.CreatedAt = now
		return tx.Create(&log).Error
	})
	return user, redemption, err
}

// DeleteUser 删除指定用户。
func DeleteUser(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.User{}, "id = ?", id).Error
}

// GetUserByLinuxDoID 根据 Linux.do ID 查询用户。
func GetUserByLinuxDoID(id string) (model.User, bool, error) {
	db, err := DB()
	if err != nil {
		return model.User{}, false, err
	}
	return findUser(db, "linux_do_id = ?", id)
}

// findUser 查询单个用户，并将未命中转换为 ok=false。
func findUser(db *gorm.DB, query string, args ...any) (model.User, bool, error) {
	user := model.User{}
	err := db.Where(query, args...).First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.User{}, false, nil
	}
	return user, err == nil, err
}
