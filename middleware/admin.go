package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

func AdminAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok || user.Role != model.UserRoleAdmin {
		handler.Fail(c.Writer, "未登录或权限不足")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

// OpsRedemptionAuth is mounted only on the three redemption-code routes that
// are exposed to the operations system. Invalid or absent internal tokens
// fall back to the regular administrator JWT authentication.
func OpsRedemptionAuth(c *gin.Context) {
	configured := strings.TrimSpace(config.Cfg.OpsRedemptionToken)
	presented := c.GetHeader("X-Internal-Redemption-Token")
	if configured != "" && len(configured) == len(presented) && subtle.ConstantTimeCompare([]byte(configured), []byte(presented)) == 1 {
		c.Request = c.Request.WithContext(service.WithOpsRedemptionAuth(c.Request.Context()))
		c.Next()
		return
	}
	AdminAuth(c)
}

func UserAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok || user.Role == model.UserRoleGuest {
		handler.Fail(c.Writer, "未登录或权限不足")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

// Client keys are scoped to the stable voice API, never administrator or key management routes.
func VoiceAuth(c *gin.Context) {
	if !strings.HasPrefix(c.GetHeader("Authorization"), "Bearer ") {
		handler.VoiceAPIFail(c.Writer, 401, "UNAUTHORIZED", "请通过 Authorization: Bearer 提供客户端 Key")
		c.Abort()
		return
	}
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	user, ok := service.ClientAPIKeyUser(token)
	if !ok && !strings.HasPrefix(token, "icv_") {
		user, ok = service.CurrentAuthUser(token)
	}
	if !ok || user.Role != model.UserRoleUser {
		handler.VoiceAPIFail(c.Writer, 401, "UNAUTHORIZED", "客户端 Key 无效、已撤销或账号不可用")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func ClientKeyManagementAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok || user.Role != model.UserRoleUser {
		handler.VoiceAPIFail(c.Writer, 401, "SESSION_REQUIRED", "请使用普通用户网页登录状态管理客户端 Key")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func OptionalAuth(c *gin.Context) {
	if user, ok := authUser(c); ok {
		c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	}
	c.Next()
}

func NotFoundJSON(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
}

func authUser(c *gin.Context) (model.AuthUser, bool) {
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if strings.TrimSpace(token) == "" {
		return model.AuthUser{}, false
	}
	return service.CurrentAuthUser(token)
}
