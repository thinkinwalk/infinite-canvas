package repository

import (
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListPublishedCases(q model.Query) ([]model.CaseApp, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CaseApp{}).Where("status = ?", model.CaseStatusPublished)
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("title LIKE ? OR description LIKE ? OR category LIKE ?", like, like, like)
	}
	if category := strings.TrimSpace(q.Category); category != "" && category != "all" {
		tx = tx.Where("category = ?", category)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.CaseApp{}
	err = tx.Order("is_official desc, run_count desc, updated_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func ListCasesByOwner(ownerID string, q model.Query) ([]model.CaseApp, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CaseApp{}).Where("owner_id = ?", ownerID)
	if status := strings.TrimSpace(q.Type); status != "" {
		tx = tx.Where("status = ?", status)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.CaseApp{}
	err = tx.Order("updated_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func ListAllCases(q model.Query) ([]model.CaseApp, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CaseApp{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("title LIKE ? OR description LIKE ? OR owner_id LIKE ?", like, like, like)
	}
	if status := strings.TrimSpace(q.Type); status != "" {
		tx = tx.Where("status = ?", status)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.CaseApp{}
	err = tx.Order("updated_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func GetCaseByID(id string) (model.CaseApp, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CaseApp{}, false, err
	}
	item := model.CaseApp{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CaseApp{}, false, nil
	}
	return item, err == nil, err
}

func SaveCase(item model.CaseApp) (model.CaseApp, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	if existing, ok, err := GetCaseByID(item.ID); err != nil {
		return item, err
	} else if ok && item.CreatedAt == "" {
		item.CreatedAt = existing.CreatedAt
	}
	return item, db.Save(&item).Error
}

func UpdateCaseStatus(id string, status model.CaseStatus, note string, version int, now string) (model.CaseApp, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CaseApp{}, false, err
	}
	updates := map[string]any{"status": status, "review_note": note, "updated_at": now}
	if version > 0 {
		updates["published_version"] = version
	}
	result := db.Model(&model.CaseApp{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil {
		return model.CaseApp{}, false, result.Error
	}
	item, ok, err := GetCaseByID(id)
	return item, ok && result.RowsAffected > 0, err
}

func IncrementCaseView(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.CaseApp{}).Where("id = ? AND status = ?", id, model.CaseStatusPublished).Updates(map[string]any{
		"view_count": gorm.Expr("view_count + ?", 1),
	}).Error
}

func IncrementCaseRun(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.CaseApp{}).Where("id = ?", id).Updates(map[string]any{
		"run_count": gorm.Expr("run_count + ?", 1),
	}).Error
}

func SaveCaseRun(run model.CaseRun) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Save(&run).Error
}

func ListCaseRunsByUser(userID string, q model.Query, caseID ...string) ([]model.CaseRun, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.CaseRun{}).Where("user_id = ?", userID)
	if len(caseID) > 0 && caseID[0] != "" {
		tx = tx.Where("case_id = ?", caseID[0])
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.CaseRun{}
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}
