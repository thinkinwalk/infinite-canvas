import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type ClientAPIKey = {
    id: string;
    name: string;
    prefix: string;
    created_at: string;
    revoked_at?: string;
};

export function fetchClientAPIKeys(token: string) {
    return apiGet<{ items: ClientAPIKey[] }>("/api/client-api-keys", undefined, token);
}

export function createClientAPIKey(token: string, name: string) {
    return apiPost<{ key: ClientAPIKey; api_key: string }>("/api/client-api-keys", { name }, token);
}

export function revokeClientAPIKey(token: string, id: string) {
    return apiDelete<boolean>(`/api/client-api-keys/${encodeURIComponent(id)}`, token);
}
