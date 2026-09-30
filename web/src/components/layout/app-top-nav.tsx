import { Bot, Menu, Moon, Sun } from "lucide-react";
import { Button, Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AppConfigModal } from "@/components/layout/app-config-modal";
import { CreateMenu } from "@/components/layout/create-menu";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const createActive = pathname === "/create" || /^\/(image|video|canvas|cases)(\/|$)/.test(pathname);
    const navLinks = [
        { to: "/assets", label: t("navigation.assets") },
        { to: "/prompts", label: t("navigation.prompts") },
    ];

    useEffect(() => {
        const media = window.matchMedia("(max-width: 1023px)");
        const update = () => setCompact(media.matches);
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-2 px-4 sm:gap-5 sm:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <span
                                    className="size-5 shrink-0 bg-current"
                                    style={{
                                        mask: "url(/logo.svg) center / contain no-repeat",
                                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                    }}
                                />
                                <span className="hidden text-base font-medium sm:inline">{t("meta.title")}</span>
                            </Link>

                            <button
                                type="button"
                                className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 lg:hidden dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label={t("topNav.openMenu")}
                                title={t("topNav.menu")}
                            >
                                <Menu className="size-5" />
                            </button>

                            <nav className="ml-8 hidden h-14 min-w-0 items-stretch gap-6 text-sm lg:flex" aria-label={t("topNav.navigation")}>
                                <CreateMenu active={createActive} />
                                {navLinks.map(({ to, label }) => (
                                    <Link
                                        key={to}
                                        to={to}
                                        className={cn(
                                            "flex shrink-0 items-center whitespace-nowrap border-b-2 transition",
                                            pathname === to || (to === "/assets" && pathname.startsWith("/assets/")) ? "border-[#217a65] font-semibold text-[#176854] dark:text-[#80d1b9]" : "border-transparent text-stone-500 hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                        )}
                                    >
                                        {label}
                                    </Link>
                                ))}
                            </nav>
                        </div>

                        <div className="my-auto flex h-9 shrink-0 items-center justify-end gap-1 whitespace-nowrap lg:gap-2">
                            {!compact ? (
                                <Tooltip title={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")}>
                                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<Bot className="size-4" />} onClick={togglePanel} aria-label={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")} />
                                </Tooltip>
                            ) : (
                                <Button
                                    type="text"
                                    shape="circle"
                                    title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                                    aria-label="切换页面主题"
                                    icon={theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                                    onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                                />
                            )}
                            <UserStatusActions accountOnly={compact} initialAuthMode={pathname === "/register" ? "register" : "login"} autoOpenAuth={pathname === "/register"} />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} pathname={pathname} onClose={() => setMobileNavOpen(false)} />
            <AppConfigModal />
        </>
    );
}
