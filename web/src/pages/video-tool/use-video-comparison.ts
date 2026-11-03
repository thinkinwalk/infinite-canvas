import { useCallback, useEffect, useRef, useState } from "react";
import { createVideoComparison } from "@/lib/video-comparison";

export function useVideoComparison(onError: () => void) {
    const original = useRef<HTMLVideoElement | null>(null);
    const result = useRef<HTMLVideoElement | null>(null);
    const control = useRef<ReturnType<typeof createVideoComparison> | undefined>(undefined);
    const error = useRef(onError);
    error.current = onError;
    const [progress, setProgress] = useState(0);
    const [waiting, setWaiting] = useState(false);
    const reset = useCallback(() => {
        control.current?.dispose();
        control.current = undefined;
        setProgress(0);
        setWaiting(false);
    }, []);
    const originalRef = useCallback((video: HTMLVideoElement | null) => {
        reset();
        original.current = video;
    }, [reset]);
    const resultRef = useCallback((video: HTMLVideoElement | null) => {
        reset();
        result.current = video;
    }, [reset]);
    const getControl = () => {
        if (!control.current && original.current && result.current) {
            control.current = createVideoComparison(original.current, result.current, {
                onProgress: setProgress,
                onState: (state) => setWaiting(state === "waiting"),
                onError: () => error.current(),
            });
        }
        return control.current;
    };
    useEffect(() => { getControl(); });
    useEffect(() => () => {
        control.current?.dispose();
        control.current = undefined;
    }, []);
    return {
        original, originalRef, resultRef, progress, waiting,
        play: () => getControl()?.play(),
        pause: () => getControl()?.pause(),
        seek: (value: number) => getControl()?.seek(value),
    };
}
