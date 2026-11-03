import { useEffect, useState } from "react";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";

export function useStoreProjectAccess(id: string) {
    const [editable, setEditable] = useState(false);
    useEffect(() => {
        if (!id) return;
        if (!navigator.locks) {
            setEditable(true);
            return;
        }
        setEditable(false);
        const controller = new AbortController();
        let release: (() => void) | undefined;
        void navigator.locks.request(`store-project-edit:${id}`, { signal: controller.signal }, async () => {
            if (controller.signal.aborted) return;
            await useVideoWorkbenchStore.persist.rehydrate();
            if (controller.signal.aborted) return;
            setEditable(true);
            await new Promise<void>((resolve) => { release = resolve; });
        }).catch(() => {});
        return () => {
            controller.abort();
            if (!useVideoWorkbenchStore.getState().storeBusyProjects[id]) release?.();
            else {
                const unsubscribe = useVideoWorkbenchStore.subscribe((state) => {
                    if (!state.storeBusyProjects[id]) { unsubscribe(); release?.(); }
                });
            }
        };
    }, [id]);
    return editable;
}
