import type { UploadedFile } from "@/services/file-storage";
import type { VideoImportSource } from "@/types/video-workbench";

export const ORIGINAL_VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const REFERENCE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const REFERENCE_REVIEW_MS = 24 * 60 * 60 * 1000;

export type TemporaryVideoReference = {
    id: string;
    userId: string;
    name: string;
    storageKey: string;
    keys: string[];
    source?: VideoImportSource;
    lastUsedAt: number;
    reviewedAt?: number;
    keep: boolean;
    cleanedAt?: number;
    analysis?: UploadedFile;
    analysisSourceKey?: string;
};

export function referenceExpiresAt(reference: TemporaryVideoReference) {
    return reference.reviewedAt === undefined ? reference.lastUsedAt + REFERENCE_IDLE_MS : reference.reviewedAt + REFERENCE_REVIEW_MS;
}

export function canCleanVideoReference(reference: TemporaryVideoReference, now: number, protectedKeys: Set<string>) {
    return !reference.keep && !reference.cleanedAt && referenceExpiresAt(reference) <= now &&
        reference.keys.every((key) => !protectedKeys.has(key));
}

export function originalVideoSizeError(bytes: number) {
    return bytes > ORIGINAL_VIDEO_MAX_BYTES ? `原视频大小约 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过 300MB 导入上限，请选择较短片段或压缩后上传` : "";
}

export function clearExpiredReferenceURLs<T>(value: T, keys: Set<string>): T {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => clearExpiredReferenceURLs(item, keys)) as T;
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [
        key, key === "url" && typeof row.storageKey === "string" && keys.has(row.storageKey) ? "" : clearExpiredReferenceURLs(item, keys),
    ])) as T;
}
