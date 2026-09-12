package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type registerRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type saveUserRequest struct {
	ID          string           `json:"id"`
	Username    string           `json:"username"`
	Password    string           `json:"password"`
	Email       string           `json:"email"`
	DisplayName string           `json:"displayName"`
	Role        model.UserRole   `json:"role"`
	Status      model.UserStatus `json:"status"`
	Group       string           `json:"group"`
}

type adjustUserCreditsRequest struct {
	Credits int    `json:"credits"`
	Reason  string `json:"reason"`
}

type redeemCodeRequest struct {
	Code string `json:"code"`
}

type createRedemptionCodesRequest struct {
	Name      string `json:"name"`
	Credits   int    `json:"credits"`
	Count     int    `json:"count"`
	ExpiresAt string `json:"expiresAt"`
	Remark    string `json:"remark"`
}

type updateRedemptionCodeStatusRequest struct {
	Status model.RedemptionCodeStatus `json:"status"`
}

func Register(w http.ResponseWriter, r *http.Request) {
	var request registerRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	session, err := service.Register(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func Login(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	session, err := service.Login(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, session)
}

func LinuxDoAuthorize(w http.ResponseWriter, r *http.Request) {
	authURL, err := service.LinuxDoAuthorizeURL(r, r.URL.Query().Get("redirect"))
	if err != nil {
		FailError(w, err)
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func LinuxDoCallback(w http.ResponseWriter, r *http.Request) {
	session, redirect, err := service.LoginWithLinuxDo(r, r.URL.Query().Get("code"), r.URL.Query().Get("state"))
	if err != nil {
		http.Redirect(w, r, loginRedirect(r, redirect, "", err.Error()), http.StatusFound)
		return
	}
	http.Redirect(w, r, loginRedirect(r, redirect, session.Token, ""), http.StatusFound)
}

func AdminLogin(w http.ResponseWriter, r *http.Request) {
	var request loginRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	session, err := service.Login(request.Username, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	if session.User.Role != model.UserRoleAdmin {
		Fail(w, "需要管理员权限")
		return
	}
	OK(w, session)
}

func CurrentUser(w http.ResponseWriter, r *http.Request) {
	if user, ok := service.UserFromContext(r.Context()); ok {
		OK(w, user)
		return
	}
	OK(w, service.GuestUser())
}

func UserCreditLogs(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	logs, err := service.ListUserCreditLogs(user.ID, parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func UserRedeemCode(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var request redeemCodeRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	updatedUser, credits, err := service.RedeemCode(user.ID, request.Code)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"user": updatedUser, "credits": credits})
}

func AdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := service.ListUsers(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, users)
}

func AdminSaveUser(w http.ResponseWriter, r *http.Request) {
	var request saveUserRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	user, err := service.SaveUser(model.User{
		ID:          request.ID,
		Username:    request.Username,
		Email:       request.Email,
		DisplayName: request.DisplayName,
		Role:        request.Role,
		Status:      request.Status,
		Group:       request.Group,
	}, request.Password)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, user)
}

func AdminAdjustUserCredits(w http.ResponseWriter, r *http.Request, id string) {
	var request adjustUserCreditsRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	operator, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	user, err := service.AdjustUserCredits(id, request.Credits, request.Reason, operator)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, user)
}

func AdminCreditLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := service.ListCreditLogs(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func AdminRedemptionCodes(w http.ResponseWriter, r *http.Request) {
	codes, err := service.ListRedemptionCodes(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, codes)
}

func AdminCreateRedemptionCodes(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var request createRedemptionCodesRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	codes, err := service.CreateRedemptionCodes(request.Name, request.Credits, request.Count, request.ExpiresAt, request.Remark, user.ID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, codes)
}

func AdminUpdateRedemptionCodeStatus(w http.ResponseWriter, r *http.Request, id string) {
	var request updateRedemptionCodeStatusRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	code, err := service.UpdateRedemptionCodeStatus(id, request.Status)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, code)
}

func AdminDeleteRedemptionCode(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteRedemptionCode(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminDeleteInvalidRedemptionCodes(w http.ResponseWriter, r *http.Request) {
	rows, err := service.DeleteInvalidRedemptionCodes()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, rows)
}

func loginRedirect(r *http.Request, redirect string, token string, message string) string {
	values := url.Values{}
	if strings.TrimSpace(token) != "" {
		values.Set("token", token)
	}
	if strings.TrimSpace(message) != "" {
		values.Set("error", message)
	}
	if strings.TrimSpace(redirect) != "" {
		values.Set("redirect", redirect)
	}
	return service.RequestOrigin(r) + "/login?" + values.Encode()
}

func AdminDeleteUser(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteUser(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}
