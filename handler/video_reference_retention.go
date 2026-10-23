package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

const temporaryReferenceHeader = "X-Video-Reference-ID"

var referenceRetentionMu sync.RWMutex

// Paid task creation and cleanup cannot race between validation and submission.
func ProtectTemporaryReferenceUse(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		referenceRetentionMu.RLock()
		defer referenceRetentionMu.RUnlock()
		next(w, r)
	}
}

type temporaryReference struct {
	ID          string   `json:"id"`
	UserID      string   `json:"userId"`
	ExpiresAt   int64    `json:"expiresAt"`
	Keep        bool     `json:"keep"`
	Reviewed    bool     `json:"reviewed"`
	Media       []string `json:"media"`
	WorkerMedia []string `json:"workerMedia"`
	Cleaned     bool     `json:"cleaned"`
}

func referenceRetentionPath(userID, id string) (string, error) {
	if parsed, err := uuid.Parse(id); err != nil || parsed.String() != id {
		return "", errors.New("临时参考素材编号无效")
	}
	return filepath.Join(referenceDataDir(), "reference-retention", fmt.Sprintf("%x-%s.json", sha256.Sum256([]byte(userID)), id)), nil
}

func changeTemporaryReference(userID, id, action, media, workerMedia string) (temporaryReference, error) {
	referenceRetentionMu.Lock()
	defer referenceRetentionMu.Unlock()
	path, err := referenceRetentionPath(userID, id)
	if err != nil {
		return temporaryReference{}, err
	}
	lease := temporaryReference{ID: id, UserID: userID}
	data, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(data, &lease); err != nil || lease.ID != id || lease.UserID != userID {
			return lease, errors.New("参考素材清理记录无法读取，已停止变更")
		}
	} else if !os.IsNotExist(err) {
		return lease, err
	}
	if lease.Cleaned {
		return lease, errors.New("临时参考视频已清理，请重新导入")
	}
	switch action {
	case "use":
		// Uploads from an already-open tab renew the lease, including after review.
		lease.Reviewed = false
		lease.ExpiresAt = time.Now().Add(7 * 24 * time.Hour).UnixMilli()
	case "review":
		lease.Reviewed = true
		lease.ExpiresAt = time.Now().Add(24 * time.Hour).UnixMilli()
	case "keep":
		lease.Keep = true
	case "temporary":
		lease.Keep = false
		lease.Reviewed = false
		lease.ExpiresAt = time.Now().Add(7 * 24 * time.Hour).UnixMilli()
	default:
		return lease, errors.New("参考素材操作无效")
	}
	if media != "" {
		lease.Media = append(lease.Media, media)
	}
	if workerMedia != "" {
		lease.WorkerMedia = append(lease.WorkerMedia, workerMedia)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return lease, err
	}
	data, _ = json.Marshal(lease)
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return lease, err
	}
	return lease, os.Rename(temp, path)
}

func VideoReferenceRetention(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		Fail(w, "请登录后管理参考素材")
		return
	}
	var input struct{ ID, Action string }
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes)
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		Fail(w, "参考素材操作格式无效")
		return
	}
	if input.Action == "status" {
		referenceRetentionMu.RLock()
		defer referenceRetentionMu.RUnlock()
		path, err := referenceRetentionPath(user.ID, input.ID)
		if err != nil {
			Fail(w, err.Error())
			return
		}
		lease := temporaryReference{ID: input.ID, UserID: user.ID}
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			Fail(w, "参考素材状态无法核对，暂缓清理")
			return
		}
		if err == nil && (json.Unmarshal(data, &lease) != nil || lease.UserID != user.ID || lease.ID != input.ID) {
			Fail(w, "参考素材状态无法核对，暂缓清理")
			return
		}
		active, err := referenceUserHasActiveTasks(user.ID)
		if err == nil && !active {
			active, err = referenceHasReplacement(lease)
		}
		canClean := err == nil && !active && !lease.Keep && lease.ExpiresAt <= time.Now().UnixMilli()
		if canClean && len(lease.WorkerMedia) > 0 && !lease.Cleaned {
			var response struct {
				Cleaned bool `json:"cleaned"`
			}
			err = replacementWorkerJSON(r.Context(), "POST", "/temporary-references/cleanup", map[string]any{"referenceId": lease.ID, "files": lease.WorkerMedia, "dryRun": true}, &response)
			canClean = err == nil && response.Cleaned
		}
		OK(w, map[string]any{"canClean": canClean})
		return
	}
	lease, err := changeTemporaryReference(user.ID, input.ID, input.Action, "", "")
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, lease)
}

// Only uploads explicitly carrying a newly-created temporary reference ID opt in.
func attachTemporaryReference(r *http.Request, media, workerMedia string) error {
	id := r.Header.Get(temporaryReferenceHeader)
	if id == "" {
		return nil
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		return errors.New("请登录后上传参考素材")
	}
	_, err := changeTemporaryReference(user.ID, id, "use", media, workerMedia)
	return err
}

func referenceUserHasActiveTasks(userID string) (bool, error) {
	db, err := repository.DB()
	if err != nil {
		return true, err
	}
	for _, table := range []any{&model.ReplicateTask{}, &model.VideoTask{}} {
		var count int64
		if err := db.Model(table).Where("user_id = ? AND status NOT IN ?", userID, []string{"completed", "failed", "cancelled", "expired"}).Count(&count).Error; err != nil {
			return true, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}

func referenceHasReplacement(lease temporaryReference) (bool, error) {
	paths, err := filepath.Glob(filepath.Join(referenceDataDir(), "replacement-jobs", "*.json"))
	if err != nil {
		return true, err
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return true, err
		}
		var job replacementJob
		if json.Unmarshal(data, &job) != nil {
			return true, errors.New("整片任务记录无法核对，暂停参考素材清理")
		}
		if job.UserID != lease.UserID {
			continue
		}
		for _, id := range lease.WorkerMedia {
			if strings.Contains(string(data), `"`+id+`"`) &&
				(job.Status != "completed" || job.CaptionStatus == "recognizing" || job.CaptionStatus == "rendering") {
				return true, nil
			}
		}
	}
	return false, nil
}

func cleanupTemporaryReferences(ctx context.Context, now time.Time) error {
	referenceRetentionMu.Lock()
	defer referenceRetentionMu.Unlock()
	paths, err := filepath.Glob(filepath.Join(referenceDataDir(), "reference-retention", "*.json"))
	if err != nil {
		return err
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var lease temporaryReference
		if json.Unmarshal(data, &lease) != nil {
			return errors.New("临时参考素材记录损坏，清理已停止")
		}
		expected, err := referenceRetentionPath(lease.UserID, lease.ID)
		if err != nil || expected != path || lease.Keep || lease.Cleaned || lease.ExpiresAt <= 0 || lease.ExpiresAt > now.UnixMilli() {
			continue
		}
		active, err := referenceUserHasActiveTasks(lease.UserID)
		if err != nil {
			return err
		}
		if active {
			continue
		}
		active, err = referenceHasReplacement(lease)
		if err != nil {
			return err
		}
		if active {
			continue
		}
		if len(lease.WorkerMedia) > 0 {
			var response struct {
				Cleaned bool `json:"cleaned"`
			}
			// The worker independently refuses deletion while any job uses the inputs.
			if err := replacementWorkerJSON(ctx, "POST", "/temporary-references/cleanup", map[string]any{"referenceId": lease.ID, "files": lease.WorkerMedia}, &response); err != nil {
				log.Printf("temporary reference worker cleanup deferred: %v", err)
				continue
			}
			if !response.Cleaned {
				continue
			}
		}
		for _, id := range lease.Media {
			if id != filepath.Base(id) || id == "." || strings.Contains(id, "..") {
				return errors.New("参考文件标识无效，清理已停止")
			}
			path := filepath.Join(referenceMediaDir(), id)
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			db, err := repository.DB()
			if err != nil {
				return err
			}
			if err := db.Where("id = ? AND user_id = ?", id, lease.UserID).Delete(&model.ReferenceMediaOwner{}).Error; err != nil {
				return err
			}
		}
		lease.Cleaned = true
		data, _ = json.Marshal(lease)
		if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
			return err
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			return err
		}
	}
	return nil
}

func StartTemporaryReferenceCleanup() {
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), aiHTTPClient.Timeout)
			err := cleanupTemporaryReferences(ctx, time.Now())
			cancel()
			if err != nil {
				log.Printf("temporary reference cleanup deferred: %v", err)
			}
			time.Sleep(time.Hour)
		}
	}()
}
