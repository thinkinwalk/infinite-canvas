package repository

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

type catalogReference struct {
	PlatformModelID string `json:"platformModelId"`
	Model           string `json:"model"`
	ChannelID       int    `json:"channelId"`
}

type catalogDeletion struct {
	label     string
	modelID   string
	routes    []model.ManagedRoute
	channelID int
}

func (d catalogDeletion) matches(ref catalogReference) bool {
	if d.channelID != 0 {
		if ref.ChannelID != 0 {
			return ref.ChannelID == d.channelID
		}
	}
	if d.modelID != "" && (ref.PlatformModelID == d.modelID || ref.Model == d.modelID) {
		return true
	}
	// A different stable model can share an upstream model without sharing history.
	if d.modelID != "" && ref.PlatformModelID != "" {
		return false
	}
	for _, route := range d.routes {
		if ref.Model == route.Model && (ref.ChannelID == route.ChannelID || ref.ChannelID == 0) {
			return true
		}
	}
	return false
}

func validateCatalogDeletions(tx *gorm.DB, saved, next model.PrivateSetting) error {
	deletions := []catalogDeletion{}
	if saved.ModelManagement != nil && next.ModelManagement != nil {
		routes, models := map[string]bool{}, map[string]bool{}
		for _, route := range next.ModelManagement.Routes {
			routes[route.ID] = true
		}
		for _, entry := range next.ModelManagement.Models {
			models[entry.ID] = true
		}
		for _, entry := range saved.ModelManagement.Models {
			if models[entry.ID] {
				continue
			}
			if entry.Enabled {
				return fmt.Errorf("请先保存停用平台模型 %s，再删除", entry.DisplayName)
			}
			deletion := catalogDeletion{label: "平台模型 " + entry.DisplayName, modelID: entry.ID}
			for _, id := range entry.RouteIDs {
				for _, route := range saved.ModelManagement.Routes {
					if route.ID == id {
						deletion.routes = append(deletion.routes, route)
					}
				}
			}
			for _, binding := range next.ModelManagement.Bindings {
				if binding.ModelID == entry.ID {
					return fmt.Errorf("%s 仍有功能绑定，请先解除绑定", deletion.label)
				}
			}
			deletions = append(deletions, deletion)
		}
		for _, route := range saved.ModelManagement.Routes {
			if routes[route.ID] {
				continue
			}
			if route.Enabled {
				return fmt.Errorf("请先保存停用渠道模型 %s，再删除", route.Model)
			}
			for _, entry := range next.ModelManagement.Models {
				for _, id := range entry.RouteIDs {
					if id == route.ID {
						return fmt.Errorf("渠道模型 %s 仍被平台模型 %s 引用，请先解除接入关系", route.Model, entry.DisplayName)
					}
				}
			}
			for _, binding := range next.ModelManagement.Bindings {
				for _, id := range binding.RouteIDs {
					if id == route.ID {
						return fmt.Errorf("渠道模型 %s 仍被功能 %s 引用，请先解除绑定", route.Model, binding.FeatureID)
					}
				}
			}
			deletions = append(deletions, catalogDeletion{label: "渠道模型 " + route.Model, routes: []model.ManagedRoute{route}})
		}
	}
	channels := map[int]bool{}
	for _, channel := range next.Channels {
		channels[channel.ID] = true
	}
	for _, channel := range saved.Channels {
		if channels[channel.ID] {
			continue
		}
		if channel.Enabled {
			return fmt.Errorf("请先保存停用渠道 %s，再删除", channel.Name)
		}
		if next.ModelManagement != nil {
			for _, route := range next.ModelManagement.Routes {
				if route.ChannelID == channel.ID {
					return fmt.Errorf("渠道 %s 仍被渠道模型 %s 引用，请先删除接入并保存", channel.Name, route.Model)
				}
			}
		}
		deletion := catalogDeletion{label: "渠道 " + channel.Name, channelID: channel.ID}
		for _, name := range channel.Models {
			deletion.routes = append(deletion.routes, model.ManagedRoute{ChannelID: channel.ID, Model: name})
		}
		deletions = append(deletions, deletion)
	}
	if len(deletions) == 0 {
		return nil
	}
	check := func(ref catalogReference, source string) error {
		for _, deletion := range deletions {
			if deletion.matches(ref) {
				return fmt.Errorf("%s 被%s引用，不能删除；请保留并停用", deletion.label, source)
			}
		}
		return nil
	}
	for _, table := range []struct {
		record          any
		label           string
		legacyChannelID int
	}{{&model.VideoTask{}, "视频任务", 0}, {&model.ReplicateTask{}, "云模型任务", saved.Replicate.LegacyChannelID}} {
		rows, err := tx.Model(table.record).Select("platform_model_id", "model", "channel_id").Rows()
		if err != nil {
			return err
		}
		for rows.Next() {
			var ref catalogReference
			if err := tx.ScanRows(rows, &ref); err != nil {
				rows.Close()
				return err
			}
			if ref.ChannelID == 0 && table.legacyChannelID != 0 {
				ref.ChannelID = table.legacyChannelID
			}
			if err := check(ref, table.label); err != nil {
				rows.Close()
				return err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	rows, err := tx.Model(&model.CreditLog{}).Select("extra").Where("type IN ?", []model.CreditLogType{model.CreditLogTypeAIConsume, model.CreditLogTypeAIRefund}).Rows()
	if err != nil {
		return err
	}
	for rows.Next() {
		var extra string
		if err := rows.Scan(&extra); err != nil {
			rows.Close()
			return err
		}
		var ref catalogReference
		if extra != "" {
			if err := json.Unmarshal([]byte(extra), &ref); err != nil {
				rows.Close()
				return fmt.Errorf("计费记录格式异常，无法确认模型引用，请先修复记录")
			}
		}
		if err := check(ref, "计费记录"); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	directory := filepath.Join(config.DataDir(), "replacement-jobs")
	files, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("无法读取整片替换任务目录，不能确认模型引用：%w", err)
	}
	for _, file := range files {
		if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, file.Name()))
		if err != nil {
			return fmt.Errorf("无法读取整片替换任务，不能确认模型引用：%w", err)
		}
		var ref catalogReference
		if err := json.Unmarshal(data, &ref); err != nil {
			return fmt.Errorf("整片替换任务格式异常，无法确认模型引用，请先修复记录")
		}
		if err := check(ref, "整片替换任务"); err != nil {
			return err
		}
	}
	return nil
}
