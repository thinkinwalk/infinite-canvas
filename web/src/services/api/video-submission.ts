import axios from "axios";

export type VideoSubmissionFailure = {
    outcome: "rejected" | "unknown";
    stage?: string;
    code?: string;
    requestId?: string;
    httpStatus?: number;
};

export class VideoSubmissionError extends Error {
    constructor(message: string, public readonly submission: VideoSubmissionFailure) {
        super(message);
        this.name = "VideoSubmissionError";
    }
}

// A received business rejection differs from losing the response to a create request.
export function videoSubmissionError(error: unknown, message: string, response?: { status?: number; data?: unknown; headers?: Record<string, unknown> }) {
    if (error instanceof VideoSubmissionError) return error;
    const received = axios.isAxiosError(error) ? error.response : response;
    const data = received?.data as { code?: string | number; error?: unknown } | undefined;
    const headers = received?.headers;
    const outcome = headers?.["x-video-submission"];
    const explicit = data && (data.code !== undefined && data.code !== 0 && data.code !== "0" || data.error);
    return new VideoSubmissionError(message, {
        outcome: outcome === "unknown" ? "unknown" : outcome === "rejected" || explicit || received?.status && received.status >= 400 && received.status < 500 ? "rejected" : "unknown",
        stage: headers?.["x-video-stage"] as string | undefined,
        code: data?.code === undefined ? undefined : String(data.code),
        requestId: headers?.["x-request-id"] as string | undefined,
        httpStatus: received?.status,
    });
}
