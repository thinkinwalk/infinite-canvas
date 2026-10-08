import { apiGet, apiPost, compactApiParams, type ApiParams } from "@/services/api/request";

export type CaseStatus = "draft" | "pending" | "published" | "rejected" | "offline";

export type CaseApp = {
    id: string;
    ownerId: string;
    title: string;
    description: string;
    coverUrl: string;
    category: string;
    tags: string[];
    status: CaseStatus;
    isOfficial: boolean;
    publicSchema: string;
    priceCredits: number;
    memberPriceCredits: number;
    costCredits: number;
    revenueSharePercent: number;
    viewCount: number;
    runCount: number;
    unlockCount: number;
    reviewNote: string;
    publishedVersion: number;
    createdAt: string;
    updatedAt: string;
};

export type CaseListResponse = { items: CaseApp[]; total: number };

export type TryonModel = { id: string; name: string; group: string; gender: string; url: string; thumb: string };
export type TryonScene = { id: string; name: string; env: string; url: string; thumb: string };
export type TryonLibrary = { models: TryonModel[]; scenes: TryonScene[] };

export type ProductSetInput = {
    images: string[];
    platform: string;
    market: string;
    language: string;
    productBrief: string;
    styleMode: "ai" | "custom" | "reference";
    styleText?: string;
    styleReferenceImages?: string[];
    layoutMode: "default" | "custom";
    customLayout?: string;
    targetImageCount: number;
    cardIds?: string[];
    planCards?: ProductSetCard[];
};

export type ProductSetCard = { id: string; category?: string; title: string; body?: string; description: string; aspectRatio: string };
export type ProductSetStyle = { id: string; title: string; description: string };
export type ProductSetPlan = { cards: ProductSetCard[]; styles: ProductSetStyle[]; targetImageCount: number };
export type ProductSetRunResult = { items: Array<{ cardId: string; category?: string; title: string; description?: string; data?: unknown; error?: string }>; failed: number; total: number };
export type ProductSetOption = { label: string; value: string; isDefault?: boolean; marketValues?: string[] };
export type ProductSetExample = { title: string; src: string };
export type ProductSetConfig = {
    entry: { title: string; description: string; cover?: string };
    platforms: ProductSetOption[];
    markets: ProductSetOption[];
    languages: ProductSetOption[];
    examples: ProductSetExample[];
    styles: ProductSetStyle[];
    targetImageCounts: number[];
};
export type CaseRun = { id: string; caseId: string; status: string; chargedCredits: number; responseBody?: string; errorMessage?: string; createdAt: string; updatedAt: string };

export type CaseDraftPayload = {
    id?: string;
    title: string;
    description?: string;
    coverUrl?: string;
    category?: string;
    tags?: string[];
    publicSchema: unknown;
    workflowSnapshot: unknown;
    runtimeConfig: unknown;
    priceCredits?: number;
    memberPriceCredits?: number;
    costCredits?: number;
    revenueSharePercent?: number;
};

export async function fetchCases(query: { keyword?: string; category?: string; page?: number; pageSize?: number } = {}) {
    return apiGet<CaseListResponse>("/api/cases", compactApiParams(query as ApiParams));
}

export async function fetchCase(id: string) {
    return apiGet<CaseApp>(`/api/cases/${id}`);
}

export async function fetchTryonLibrary() {
    return apiGet<TryonLibrary>("/api/tryon/library");
}

export async function runCase(token: string, id: string, inputs: Record<string, unknown>) {
    return apiPost<unknown>(`/api/cases/${id}/run`, { inputs }, token);
}

export type CaseRunPrice = { points: number; modelPoints: number; servicePoints: number; count: number };

export async function fetchCaseRunPrice(token: string, id: string, count?: number) {
    return apiGet<CaseRunPrice>(`/api/cases/${id}/run-price`, count ? { count } : undefined, token);
}

export async function fetchVariationAssistPrice(token: string) {
    return apiGet<{ points: number }>("/api/cases/official-image-variations/variations/assist-price", undefined, token);
}

export async function assistVariationPrompt(token: string, input: { imageUrl: string; mode: string; prompt: string; action: "write" | "optimize" }) {
    return apiPost<{ prompt: string }>("/api/cases/official-image-variations/variations/assist", input, token);
}

export async function streamImageVariations(token: string, inputs: Record<string, unknown>, onItem: (item: unknown, completed: number, total: number) => void) {
    let response: Response;
    try {
        response = await fetch("/api/cases/official-image-variations/run?stream=1", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ inputs }),
        });
    } catch {
        throw new Error("接口连接失败，请确认后端服务已启动");
    }
    if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
        const error = (await response.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(error?.msg || "图裂变请求失败");
    }
    if (!response.body) throw new Error("生成连接中断，已完成结果可在历史中查看");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let failed = 0;
    let total = 0;
    const receive = (line: string) => {
        const event = JSON.parse(line) as { type: string; item?: unknown; completed?: number; total?: number; failed?: number };
        if (event.type === "item") onItem(event.item, event.completed || 0, event.total || 0);
        if (event.type === "done") {
            done = true;
            failed = event.failed || 0;
            total = event.total || 0;
        }
    };
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end = buffer.indexOf("\n");
            while (end >= 0) {
                const line = buffer.slice(0, end).trim();
                if (line) receive(line);
                buffer = buffer.slice(end + 1);
                end = buffer.indexOf("\n");
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) receive(buffer.trim());
    } finally {
        reader.releaseLock();
    }
    if (!done) throw new Error("生成连接中断，已完成结果可在历史中查看");
    return { failed, total };
}

export async function planProductSet(token: string, id: string, inputs: ProductSetInput) {
    return apiPost<ProductSetPlan>(`/api/cases/${id}/product-set/plan`, { inputs }, token);
}

export async function fetchProductSetPlanPrice(token: string, id: string) {
    return apiGet<{ points: number }>(`/api/cases/${id}/product-set/plan-price`, undefined, token);
}

export async function fetchProductSetImagePrice(token: string, id: string) {
    return apiGet<{ model: string; pointsPerImage: number }>(`/api/cases/${id}/product-set/image-price`, undefined, token);
}

export async function analyzeProductSet(token: string, id: string, inputs: ProductSetInput) {
    return apiPost<{ productBrief: string }>(`/api/cases/${id}/product-set/analyze`, { inputs }, token);
}

export async function parseProductSet(token: string, id: string, inputs: ProductSetInput) {
    return apiPost<{ productBrief: string; styles: ProductSetStyle[] }>(`/api/cases/${id}/product-set/parse`, { inputs }, token);
}

export async function recommendProductSetStyle(token: string, id: string, inputs: ProductSetInput) {
    return apiPost<{ styles: ProductSetStyle[] }>(`/api/cases/${id}/product-set/recommend-style`, { inputs }, token);
}

export async function runProductSet(token: string, id: string, inputs: ProductSetInput) {
    return apiPost<ProductSetRunResult>(`/api/cases/${id}/product-set/run`, { inputs }, token);
}

export async function streamProductSet(token: string, id: string, inputs: ProductSetInput, onItem: (item: ProductSetRunResult["items"][number], completed: number, total: number) => void): Promise<ProductSetRunResult> {
    let response: Response;
    try {
        response = await fetch(`/api/cases/${id}/product-set/run?stream=1`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ inputs }),
        });
    } catch {
        throw new Error("接口连接失败，请确认后端服务已启动");
    }
    if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
        const error = (await response.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(error?.msg || "商品套图生成请求失败");
    }
    if (!response.body) throw new Error("生成连接中断，已完成结果可在历史中查看");

    const items: ProductSetRunResult["items"] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let failed = 0;
    let total = 0;
    const receive = (line: string) => {
        const event = JSON.parse(line) as { type: string; item?: ProductSetRunResult["items"][number]; completed?: number; total?: number; failed?: number };
        if (event.type === "item" && event.item?.cardId) {
            items.push(event.item);
            onItem(event.item, event.completed || items.length, event.total || items.length);
        } else if (event.type === "done") {
            done = true;
            failed = event.failed || 0;
            total = event.total || items.length;
        }
    };
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end = buffer.indexOf("\n");
            while (end >= 0) {
                const line = buffer.slice(0, end).trim();
                if (line) receive(line);
                buffer = buffer.slice(end + 1);
                end = buffer.indexOf("\n");
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) receive(buffer.trim());
    } finally {
        reader.releaseLock();
    }
    if (!done) throw new Error("生成连接中断，已完成结果可在历史中查看");
    return { items, failed, total };
}

export async function fetchProductSetConfig(id = "official-product-grid") {
    return apiGet<ProductSetConfig>(`/api/cases/${id}/product-set/config`);
}

export async function fetchCaseRuns(token: string, query: { page?: number; pageSize?: number; caseId?: string } = {}) {
    return apiGet<{ items: CaseRun[]; total: number }>("/api/creator/case-runs", compactApiParams(query as ApiParams), token);
}

export async function fetchOwnedCases(token: string, query: { status?: CaseStatus; page?: number; pageSize?: number } = {}) {
    return apiGet<CaseListResponse>("/api/creator/cases", compactApiParams({ ...query, type: query.status } as ApiParams), token);
}

export async function saveCaseDraft(token: string, payload: CaseDraftPayload) {
    return apiPost<CaseApp>("/api/creator/cases", payload, token);
}

export async function submitCase(token: string, id: string) {
    return apiPost<CaseApp>(`/api/creator/cases/${id}/submit`, {}, token);
}
