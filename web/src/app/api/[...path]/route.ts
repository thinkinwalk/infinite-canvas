import type { NextRequest } from "next/server";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const maxDuration = 900;

const PROXY_TIMEOUT_MS = 15 * 60 * 1000;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

function proxyHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return headers;
}

function responseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}

function nodeRequestHeaders(headers: Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

function nodeResponseHeaders(headers: IncomingHttpHeaders) {
    const result = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (key === "content-length" || key === "content-encoding" || key === "transfer-encoding") continue;
        if (Array.isArray(value)) value.forEach((item) => result.append(key, item));
        else if (value !== undefined) result.set(key, String(value));
    }
    return result;
}

function proxyWithNodeRequest(request: NextRequest, target: string, hasBody: boolean) {
    const url = new URL(target);
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<Response>((resolve, reject) => {
        const upstream = client(
            url,
            {
                method: request.method,
                headers: nodeRequestHeaders(proxyHeaders(request)),
                timeout: PROXY_TIMEOUT_MS,
            },
            (upstreamResponse) => {
                resolve(
                    new Response(Readable.toWeb(upstreamResponse) as ReadableStream, {
                        status: upstreamResponse.statusCode || 502,
                        statusText: upstreamResponse.statusMessage,
                        headers: nodeResponseHeaders(upstreamResponse.headers),
                    }),
                );
            },
        );

        upstream.on("timeout", () => {
            upstream.destroy(new Error(`Proxy request timed out after ${PROXY_TIMEOUT_MS}ms`));
        });
        upstream.on("error", reject);

        if (!hasBody || !request.body) {
            upstream.end();
            return;
        }

        const body = Readable.fromWeb(request.body as ReadableStream<Uint8Array>);
        body.on("error", (error) => upstream.destroy(error));
        body.pipe(upstream);
    });
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
        const response = await proxyWithNodeRequest(request, target, hasBody);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response),
        });
    } catch (error) {
        console.error("Failed to proxy", target, error);
        return Response.json({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }, { status: 502 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
