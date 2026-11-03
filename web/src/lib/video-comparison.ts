type ComparisonState = "paused" | "waiting" | "playing";
type ComparisonCallbacks = {
    onProgress?: (progress: number) => void;
    onState?: (state: ComparisonState) => void;
    onError?: () => void;
};

function waitForMedia(video: HTMLVideoElement, readyState: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const events = ["loadedmetadata", "loadeddata", "canplay", "canplaythrough", "seeked", "progress", "error"];
        const cleanup = () => {
            for (const event of events) video.removeEventListener(event, check);
            signal.removeEventListener("abort", check);
        };
        const check = () => {
            if (signal.aborted || video.error) {
                cleanup();
                reject(signal.aborted ? new DOMException("Playback cancelled", "AbortError") : new Error("Video cannot be played"));
            } else if (video.readyState >= readyState && !video.seeking) {
                cleanup();
                resolve();
            }
        };
        for (const event of events) video.addEventListener(event, check);
        signal.addEventListener("abort", check);
        check();
    });
}

export function createVideoComparison(source: HTMLVideoElement, target: HTMLVideoElement, callbacks: ComparisonCallbacks = {}) {
    const players = [source, target];
    const listeners: (() => void)[] = [];
    let state: ComparisonState = "paused";
    let operation: AbortController | undefined;
    let disposed = false;
    const valid = () => players.every((video) => Number.isFinite(video.duration) && video.duration > 0);
    const progress = (video = target) => valid() ? video.currentTime / video.duration * 100 : 0;
    const setState = (value: ComparisonState) => { state = value; callbacks.onState?.(value); };
    const position = (value: number) => {
        for (const video of players) {
            const time = video.duration * value / 100;
            if (video.currentTime !== time) video.currentTime = time;
        }
        callbacks.onProgress?.(value);
    };
    const pausePlayers = () => {
        for (const video of players) video.pause();
        source.playbackRate = 1;
    };
    const pause = () => {
        operation?.abort();
        operation = undefined;
        setState("paused");
        pausePlayers();
    };
    const start = async (value?: number) => {
        operation?.abort();
        const current = new AbortController();
        operation = current;
        setState("waiting");
        pausePlayers();
        try {
            for (const video of players) video.preload = "auto";
            await Promise.all(players.map((video) => waitForMedia(video, 1, current.signal)));
            if (!valid()) throw new Error("Invalid video duration");
            position(value ?? (target.ended || target.currentTime >= target.duration ? 0 : progress()));
            await Promise.all(players.map((video) => waitForMedia(video, 4, current.signal)));
            if (current.signal.aborted) return;
            source.playbackRate = source.duration / target.duration * target.playbackRate;
            setState("playing");
            await Promise.all(players.map((video) => video.play()));
        } catch {
            if (current.signal.aborted || disposed) return;
            pause();
            callbacks.onError?.();
        }
    };
    const listen = (video: HTMLVideoElement, event: string, action: () => void) => {
        video.addEventListener(event, action);
        listeners.push(() => video.removeEventListener(event, action));
    };
    for (const video of players) {
        // play() can resolve before a later waiting event; keep both players together.
        const wait = () => {
            if (state !== "playing" || video.readyState >= 3) return;
            const value = progress(video);
            // A Blob decoder may stay waiting until its current frame is sought again.
            void start(value);
            try { video.currentTime = video.currentTime; } catch { pause(); callbacks.onError?.(); }
        };
        listen(video, "waiting", wait);
        listen(video, "stalled", wait);
        listen(video, "seeking", () => { if (state === "playing") void start(progress(video)); });
        listen(video, "pause", () => { if (state === "playing" && video.paused && !video.ended) pause(); });
        listen(video, "ended", () => { if (video === target && state !== "paused") { pause(); if (valid()) position(100); } });
        listen(video, "error", () => { if (state !== "paused") { pause(); callbacks.onError?.(); } });
        listen(video, "emptied", () => { if (state !== "paused") pause(); });
    }
    listen(target, "timeupdate", () => callbacks.onProgress?.(progress()));
    listen(target, "ratechange", () => {
        if (state === "playing" && valid()) source.playbackRate = source.duration / target.duration * target.playbackRate;
    });
    return {
        play: () => { if (!disposed && state === "paused") void start(); },
        pause,
        seek: (value: number) => {
            if (!valid() || disposed) return;
            const next = Math.max(0, Math.min(100, value));
            if (state !== "paused" && next < 100) void start(next);
            else { pause(); position(next); }
        },
        dispose: () => {
            disposed = true;
            operation?.abort();
            for (const remove of listeners) remove();
            state = "paused";
            pausePlayers();
        },
    };
}
