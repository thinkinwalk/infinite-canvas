import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type ClientAPIKey = {
    id: string;
    name: string;
    prefix: string;
    created_at: string;
    revoked_at?: string;
};

function keyPath(userId?: string) {
    return userId ? `/api/admin/users/${encodeURIComponent(userId)}/client-api-keys` : "/api/client-api-keys";
}

export function fetchClientAPIKeys(token: string, userId?: string) {
    return apiGet<{ items: ClientAPIKey[] }>(keyPath(userId), undefined, token);
}

export function createClientAPIKey(token: string, name: string, userId?: string) {
    return apiPost<{ key: ClientAPIKey; api_key: string }>(keyPath(userId), { name }, token);
}

export function revokeClientAPIKey(token: string, id: string, userId?: string) {
    return apiDelete<boolean>(`${keyPath(userId)}/${encodeURIComponent(id)}`, token);
}
