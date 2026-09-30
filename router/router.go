package router

import (
	"net/http"
	"os"
	urlpath "path"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.GET("/auth/linux-do/authorize", gin.WrapF(handler.LinuxDoAuthorize))
	api.GET("/auth/linux-do/callback", gin.WrapF(handler.LinuxDoCallback))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/credit-logs", middleware.UserAuth, gin.WrapF(handler.UserCreditLogs))
	api.POST("/redeem", middleware.UserAuth, gin.WrapF(handler.UserRedeemCode))
	api.GET("/ops/invite-users", gin.WrapF(handler.InviteUsers))
	api.GET("/settings", middleware.OptionalAuth, gin.WrapF(handler.Settings))
	api.GET("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	api.HEAD("/media/references/:id", func(c *gin.Context) {
		handler.ReferenceMedia(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth)
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/responses", gin.WrapF(handler.AIResponses))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.POST("/audio/speech", gin.WrapF(handler.AIAudioSpeech))
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.POST("/media/references", gin.WrapF(handler.UploadReferenceMedia))
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	api.GET("/cases", gin.WrapF(handler.Cases))
	api.GET("/tryon/library", gin.WrapF(handler.TryonLibrary))
	api.GET("/cases/:id", func(c *gin.Context) {
		handler.CaseDetail(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/run", middleware.UserAuth, func(c *gin.Context) {
		handler.RunCase(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/cases/:id/run-price", middleware.UserAuth, func(c *gin.Context) {
		handler.CaseRunPrice(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/cases/:id/variations/assist-price", middleware.UserAuth, func(c *gin.Context) {
		handler.VariationAssistPrice(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/variations/assist", middleware.UserAuth, func(c *gin.Context) {
		handler.VariationAssist(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/product-set/plan", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetPlan(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/cases/:id/product-set/plan-price", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetPlanPrice(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/cases/:id/product-set/image-price", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetImagePrice(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/cases/:id/product-set/config", gin.WrapF(handler.ProductSetConfig))
	api.POST("/cases/:id/product-set/analyze", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetAnalyze(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/product-set/parse", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetParse(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/product-set/recommend-style", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetRecommendStyle(c.Writer, c.Request, c.Param("id"))
	})
	api.POST("/cases/:id/product-set/run", middleware.UserAuth, func(c *gin.Context) {
		handler.ProductSetRun(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/creator/cases", middleware.UserAuth, gin.WrapF(handler.OwnedCases))
	api.POST("/creator/cases", middleware.UserAuth, gin.WrapF(handler.CreateCase))
	api.POST("/creator/cases/:id/submit", middleware.UserAuth, func(c *gin.Context) {
		handler.SubmitCase(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/creator/case-runs", middleware.UserAuth, gin.WrapF(handler.CaseRuns))
	api.POST("/admin/login", gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.GET("/redemption-codes", gin.WrapF(handler.AdminRedemptionCodes))
	admin.POST("/redemption-codes", gin.WrapF(handler.AdminCreateRedemptionCodes))
	admin.DELETE("/redemption-codes/invalid", gin.WrapF(handler.AdminDeleteInvalidRedemptionCodes))
	admin.POST("/redemption-codes/:id/status", func(c *gin.Context) {
		handler.AdminUpdateRedemptionCodeStatus(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/redemption-codes/:id", func(c *gin.Context) {
		handler.AdminDeleteRedemptionCode(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/settings/channel-models", gin.WrapF(handler.AdminChannelModels))
	admin.POST("/settings/channel-test", gin.WrapF(handler.AdminTestChannelModel))
	admin.POST("/settings/replicate-test", gin.WrapF(handler.AdminTestReplicate))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/cases", gin.WrapF(handler.AdminCases))
	admin.POST("/cases", gin.WrapF(handler.AdminCreateCase))
	admin.POST("/cases/:id/review", func(c *gin.Context) {
		handler.AdminReviewCase(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(staticAppFallback())

	return router
}

func staticAppFallback() gin.HandlerFunc {
	return func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			middleware.NotFoundJSON(c)
			return
		}
		staticDir := strings.TrimSpace(config.Cfg.StaticDir)
		indexPath := filepath.Join(staticDir, "index.html")
		if staticDir == "" || !fileExists(indexPath) {
			middleware.NotFoundJSON(c)
			return
		}
		requestPath := strings.TrimPrefix(urlpath.Clean(c.Request.URL.Path), "/")
		if requestPath != "." && requestPath != "" {
			filePath := filepath.Join(staticDir, filepath.FromSlash(requestPath))
			if isInsideDir(staticDir, filePath) && fileExists(filePath) {
				c.File(filePath)
				return
			}
		}
		c.Header("Cache-Control", "no-cache")
		c.File(indexPath)
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func isInsideDir(baseDir string, targetPath string) bool {
	baseAbs, err := filepath.Abs(baseDir)
	if err != nil {
		return false
	}
	targetAbs, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(baseAbs, targetAbs)
	return err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}
