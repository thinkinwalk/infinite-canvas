import { useEffect } from "react";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

export function useVideoCreationConfig() {
    const config = useEffectiveConfig();
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    useEffect(() => {
        const refresh = () => { void loadPublicSettings(); };
        const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); };
        refresh();
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refreshVisible);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refreshVisible);
        };
    }, [loadPublicSettings]);
    return config;
}
