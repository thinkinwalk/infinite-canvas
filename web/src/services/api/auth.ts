import { apiGet, apiPost, compactApiParams, type ApiParams } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export type CreditLog = {
    id: string;
    userId: string;
    type: string;
    amount: number;
    balance: number;
    relatedId: string;
    remark: string;
    extra: string;
    createdAt: string;
};

export type CreditLogListResponse = {
    items: CreditLog[];
    total: number;
};

export type CreditLogQuery = {
    keyword?: string;
    type?: string;
    page?: number;
    pageSize?: number;
};

export type RedeemCodeResponse = {
    user: AuthUser;
    credits: number;
};

export async function login(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/login", payload);
}

export async function adminLogin(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/admin/login", payload);
}

export async function register(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/register", payload);
}

export async function fetchCurrentUser(token?: string) {
    return apiGet<AuthUser>("/api/auth/me", undefined, token);
}

export async function fetchUserCreditLogs(token: string, query: CreditLogQuery = {}) {
    return apiGet<CreditLogListResponse>("/api/credit-logs", compactApiParams(query as ApiParams), token);
}

export async function redeemCode(token: string, code: string) {
    return apiPost<RedeemCodeResponse>("/api/redeem", { code }, token);
}
