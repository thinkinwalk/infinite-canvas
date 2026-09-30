import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    const location = useLocation();
    const isCreatePage = location.pathname === "/create" || location.pathname === "/create-preview";
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {isCreatePage ? null : <AppTopNav />}
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {isCreatePage ? null : <AgentPanel />}
        </div>
    );
}
