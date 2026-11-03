import { expect, test } from "bun:test";
import { createVideoComparison } from "../src/lib/video-comparison";

class Video extends EventTarget {
    duration = 5;
    readyState = 4;
    seeking = false;
    paused = true;
    ended = false;
    error: { code: number } | null = null;
    preload = "metadata";
    playbackRate = 1;
    playCalls = 0;
    seeks = 0;
    time = 0;
    failure = false;
    get currentTime() { return this.time; }
    set currentTime(time: number) {
        this.time = time;
        this.ended = false;
        this.seeking = true;
        this.seeks++;
        this.emit("seeking");
        queueMicrotask(() => { this.seeking = false; this.emit("seeked"); });
    }
    emit(event: string) { this.dispatchEvent(new Event(event)); }
    play() {
        this.playCalls++;
        if (this.failure) return Promise.reject(new Error("NotAllowedError"));
        this.paused = false;
        queueMicrotask(() => this.emit("playing"));
        return Promise.resolve();
    }
    pause() {
        if (this.paused) return;
        this.paused = true;
        queueMicrotask(() => this.emit("pause"));
    }
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function pair(source = new Video(), target = new Video()) {
    const states: string[] = [], errors: boolean[] = [], progress: number[] = [];
    const control = createVideoComparison(source as unknown as HTMLVideoElement, target as unknown as HTMLVideoElement, {
        onState: (state) => states.push(state), onError: () => errors.push(true), onProgress: (value) => progress.push(value),
    });
    return { source, target, states, errors, progress, control };
}

test("both players wait for playable data and completed seeks before starting", async () => {
    const p = pair();
    p.target.readyState = 2;
    p.target.time = 2;
    p.source.duration = 10;
    p.control.play();
    await settle();
    expect(p.source.playCalls).toBe(0);
    expect(p.target.playCalls).toBe(0);
    expect(p.source.time).toBe(4);
    expect(p.source.preload).toBe("auto");
    expect(p.target.preload).toBe("auto");
    p.target.readyState = 4;
    p.target.emit("canplay");
    await settle();
    expect(p.source.paused).toBe(false);
    expect(p.target.paused).toBe(false);
    expect(p.source.playbackRate).toBe(2);
    expect(p.errors).toEqual([]);
    p.control.dispose();
});

test("waiting after successful play pauses both and realigns on recovery", async () => {
    const p = pair();
    p.source.duration = 10;
    p.control.play();
    await settle();
    p.source.time = 3;
    p.target.time = 1;
    p.target.readyState = 2;
    p.target.emit("waiting");
    expect(p.source.paused).toBe(true);
    expect(p.target.paused).toBe(true);
    await settle();
    expect(p.source.time).toBe(2);
    expect(p.states.at(-1)).toBe("waiting");
    expect(p.target.seeks).toBeGreaterThan(0);
    p.target.readyState = 4;
    p.target.emit("canplay");
    await settle();
    expect(p.source.playCalls).toBe(2);
    expect(p.target.playCalls).toBe(2);
    expect(p.states.at(-1)).toBe("playing");
    expect(p.errors).toEqual([]);
    p.control.dispose();
});

test("source stalls also pause the result and recovery uses the stalled side's position", async () => {
    const p = pair();
    p.control.play();
    await settle();
    p.source.time = 1;
    p.target.time = 2;
    p.source.readyState = 2;
    p.source.emit("stalled");
    await settle();
    expect(p.target.paused).toBe(true);
    expect(p.target.time).toBe(1);
    p.source.readyState = 4;
    p.source.emit("canplay");
    await settle();
    expect(p.target.paused).toBe(false);
    p.control.dispose();
});

test("pause cancels readiness waits and prevents a late automatic resume", async () => {
    const p = pair();
    p.target.readyState = 2;
    p.control.play();
    await settle();
    p.control.pause();
    p.target.readyState = 4;
    p.target.emit("canplay");
    await settle();
    expect(p.source.playCalls).toBe(0);
    expect(p.target.playCalls).toBe(0);
    expect(p.states.at(-1)).toBe("paused");
    expect(p.errors).toEqual([]);
    p.control.dispose();
});

test("seeking during playback restarts the pair at the latest proportional position", async () => {
    const p = pair();
    p.source.duration = 10;
    p.control.play();
    await settle();
    p.control.seek(25);
    p.control.seek(60);
    await settle();
    expect(p.source.time).toBe(6);
    expect(p.target.time).toBe(3);
    expect(p.source.playCalls).toBe(2);
    expect(p.target.playCalls).toBe(2);
    p.control.seek(100);
    await settle();
    expect(p.source.paused).toBe(true);
    expect(p.target.paused).toBe(true);
    p.control.play();
    await settle();
    expect(p.source.time).toBe(0);
    expect(p.target.time).toBe(0);
    p.control.dispose();
});

test("ended replay resets both and native pause stops the linked session", async () => {
    const p = pair();
    p.target.time = 5;
    p.target.ended = true;
    p.control.play();
    await settle();
    expect(p.target.time).toBe(0);
    expect(p.source.paused).toBe(false);
    p.target.pause();
    await settle();
    expect(p.source.paused).toBe(true);
    expect(p.states.at(-1)).toBe("paused");
    p.control.dispose();
});

test("play rejection pauses both and reports one failure", async () => {
    const p = pair();
    p.target.failure = true;
    p.control.play();
    await settle();
    expect(p.source.paused).toBe(true);
    expect(p.target.paused).toBe(true);
    expect(p.source.playbackRate).toBe(1);
    expect(p.errors).toEqual([true]);
    p.control.dispose();
});

test("disposal removes listeners and cancels pending recovery", async () => {
    const p = pair();
    p.control.play();
    await settle();
    p.target.readyState = 2;
    p.target.emit("waiting");
    await settle();
    p.control.dispose();
    p.target.readyState = 4;
    p.target.emit("canplay");
    p.target.emit("timeupdate");
    await settle();
    expect(p.source.playCalls).toBe(1);
    expect(p.target.playCalls).toBe(1);
    expect(p.source.paused).toBe(true);
    expect(p.errors).toEqual([]);
});

test("network stalled with playable data does not interrupt playback", async () => {
    const p = pair();
    p.control.play();
    await settle();
    p.target.emit("stalled");
    await settle();
    expect(p.target.playCalls).toBe(1);
    expect(p.source.paused).toBe(false);
    p.target.playbackRate = 1.5;
    p.target.emit("ratechange");
    expect(p.source.playbackRate).toBe(1.5);
    p.control.dispose();
});
