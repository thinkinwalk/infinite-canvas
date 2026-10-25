package repository

import (
	"encoding/json"
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GetSettings 返回 public 和 private 两行配置。
func GetSettings() (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return model.Settings{}, err
	}
	var items []model.Setting
	if err := db.Find(&items).Error; err != nil {
		return model.Settings{}, err
	}
	result := model.Settings{}
	for _, item := range items {
		if item.Key == model.SettingKeyPrivate {
			_ = json.Unmarshal(item.Value, &result.Private)
		} else if item.Key == model.SettingKeyPublic {
			_ = json.Unmarshal(item.Value, &result.Public)
		}
	}
	return result, nil
}

// Lock and validate the catalog revision before atomically saving both rows.
func SaveSettingsChecked(settings model.Settings, previous *model.ModelManagement, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return settings, err
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var row model.Setting
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("key = ?", model.SettingKeyPrivate).First(&row).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var stored model.PrivateSetting
		if len(row.Value) > 0 {
			if err := json.Unmarshal(row.Value, &stored); err != nil {
				return err
			}
		}
		expected := 0
		if previous != nil {
			expected = previous.Revision
		}
		incoming := 0
		if settings.Private.ModelManagement != nil {
			incoming = settings.Private.ModelManagement.Revision
		}
		current := 0
		if stored.ModelManagement != nil {
			current = stored.ModelManagement.Revision
		}
		if expected != current || incoming != current {
			return errors.New("配置已被其他管理员修改，请重新加载后保存")
		}
		if stored.ModelManagement != nil && settings.Private.ModelManagement == nil {
			return errors.New("已有模型目录不能清除，请在模型管理中停用")
		}
		if err := validateCatalogDeletions(tx, stored, settings.Private); err != nil {
			return err
		}
		if settings.Private.ModelManagement != nil && stored.ModelManagement == nil {
			var publicRow model.Setting
			if err := tx.Where("key = ?", model.SettingKeyPublic).First(&publicRow).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			var public model.PublicSetting
			if len(publicRow.Value) > 0 {
				if err := json.Unmarshal(publicRow.Value, &public); err != nil {
					return err
				}
			}
			backup, err := json.Marshal(model.Settings{Private: stored, Public: public})
			if err != nil {
				return err
			}
			if err := tx.Create(&model.Setting{Key: model.SettingKey("model-management-original"), Value: backup, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				return err
			}
		}
		if settings.Private.ModelManagement != nil {
			settings.Private.ModelManagement.Revision = current + 1
		}
		privateValue, err := json.Marshal(settings.Private)
		if err != nil {
			return err
		}
		if len(row.Value) == 0 {
			if err := tx.Create(&model.Setting{Key: model.SettingKeyPrivate, Value: privateValue, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				return err
			}
		} else {
			row.Value, row.UpdatedAt = privateValue, now
			result := tx.Save(&row)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errors.New("配置已变化，请重新加载后保存")
			}
		}
		settings.Public.ModelChannel.Managed = nil
		publicValue, err := json.Marshal(settings.Public)
		if err != nil {
			return err
		}
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"})}).Create(&model.Setting{Key: model.SettingKeyPublic, Value: publicValue, CreatedAt: now, UpdatedAt: now}).Error
	})
	return settings, err
}

// SaveSettings 保存 public 和 private 两行配置。
func SaveSettings(settings model.Settings, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return settings, err
	}
	publicValue, _ := json.Marshal(settings.Public)
	privateValue, _ := json.Marshal(settings.Private)
	items := []model.Setting{
		{Key: model.SettingKeyPublic, Value: publicValue, CreatedAt: now, UpdatedAt: now},
		{Key: model.SettingKeyPrivate, Value: privateValue, CreatedAt: now, UpdatedAt: now},
	}
	err = db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&items).Error
	return settings, err
}
