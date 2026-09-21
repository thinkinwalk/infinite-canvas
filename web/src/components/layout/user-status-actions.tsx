import { useEffect, useState, type CSSProperties } from "react";
import { App, Form, Input, Modal, Segmented, Tooltip } from "antd";
import { BookOpen, Keyboard, LogOut, Puzzle, Settings2, UserRound, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CreditCenterModal } from "@/components/layout/credit-center-modal";
import { GitHubLink } from "@/components/layout/github-link";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { clearInvitationRef, resolveInvitationRef } from "@/lib/invitation-ref";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import type { AuthPayload } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    showGitHub?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
    initialAuthMode?: AuthMode;
    autoOpenAuth?: boolean;
};

type AuthMode = "login" | "register";

export function UserStatusActions({ showConfig = true, showGitHub = true, variant = "default", onOpenShortcuts, onOpenPlugins, initialAuthMode = "login", autoOpenAuth = false }: UserStatusActionsProps) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const [authOpen, setAuthOpen] = useState(false);
    const [authMode, setAuthMode] = useState<AuthMode>("login");
    const [creditCenterOpen, setCreditCenterOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [form] = Form.useForm<AuthPayload>();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth.allowRegister ?? true);
    const user = useUserStore((state) => state.user);
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const clearSession = useUserStore((state) => state.clearSession);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    const userName = user?.displayName || user?.username || "用户";
    const hasCredits = typeof user?.credits === "number";
    const formattedCredits = hasCredits ? new Intl.NumberFormat("zh-CN").format(user.credits) : "";
    const creditStyle: CSSProperties | undefined =
        variant === "canvas"
            ? {
                  color: canvasTheme.node.text,
                  borderColor: canvasTheme.toolbar.border,
                  backgroundColor: canvasTheme.toolbar.panel,
              }
            : undefined;
    const authOptions: Array<{ label: string; value: AuthMode }> = [
        { label: "登录", value: "login" },
        ...(allowRegister ? [{ label: "注册", value: "register" as const }] : []),
    ];

    useEffect(() => {
        if (autoOpenAuth && !user) {
            setAuthMode(initialAuthMode);
            setAuthOpen(true);
        }
    }, [autoOpenAuth, initialAuthMode, user]);

    async function handleAuth(values: AuthPayload) {
        setSubmitting(true);
        try {
            if (authMode === "register") {
                const ref = resolveInvitationRef(window.location.search, window.sessionStorage);
                await register(ref ? { ...values, ref } : values);
                clearInvitationRef(window.sessionStorage);
            } else {
                await login(values);
            }
            setAuthOpen(false);
            form.resetFields();
            message.success(authMode === "register" ? "注册成功" : "登录成功");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setSubmitting(false);
        }
    }

    function openAuth(mode: AuthMode) {
        setAuthMode(mode);
        setAuthOpen(true);
    }

    function creditBadgeClass(credits: number) {
        if (variant === "canvas") return "border shadow-sm";
        if (credits <= 0) return "border-red-200 bg-red-50 text-red-700 shadow-sm dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200";
        if (credits < 100) return "border-amber-200 bg-amber-50 text-amber-700 shadow-sm dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-100";
        return "border-sky-200 bg-sky-50 text-sky-700 shadow-sm dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-100";
    }

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {user ? (
                <>
                    {hasCredits ? (
                        <button
                            type="button"
                            className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold leading-none transition ${creditBadgeClass(user.credits)}`}
                            style={creditStyle}
                            onClick={() => setCreditCenterOpen(true)}
                            aria-label="算力中心"
                            title={`${userName} · 算力中心`}
                        >
                            <Zap className="size-3.5" />
                            <span>算力</span>
                            <span className="tabular-nums">{formattedCredits}</span>
                            <span className="font-medium opacity-75">点</span>
                        </button>
                    ) : null}
                    <button type="button" className={naturalIconClass} style={iconStyle} aria-label={userName} title={userName}>
                        <UserRound className="size-4" />
                    </button>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={clearSession} aria-label="退出登录" title="退出登录">
                        <LogOut className="size-4" />
                    </button>
                </>
            ) : null}
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label={t("topNav.docs")} title={t("topNav.docs")}>
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            {showGitHub ? <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} /> : null}
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {!user ? (
                <div className="ml-1 inline-flex shrink-0 items-center gap-1">
                    <button type="button" className="inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-stone-600 transition hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white" onClick={() => openAuth("login")}>
                        登录
                    </button>
                    {allowRegister ? (
                        <button type="button" className="inline-flex h-8 items-center rounded-md bg-stone-950 px-3 text-sm font-medium text-white transition hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white" onClick={() => openAuth("register")}>
                            注册
                        </button>
                    ) : null}
                </div>
            ) : null}
            <CreditCenterModal open={creditCenterOpen} onOpenChange={setCreditCenterOpen} />
            <Modal title={authMode === "register" ? "注册账号" : "登录账号"} open={authOpen} onCancel={() => setAuthOpen(false)} onOk={() => form.submit()} okText={authMode === "register" ? "注册" : "登录"} cancelText="取消" confirmLoading={submitting} destroyOnHidden>
                <div className="mb-4">
                    <Segmented<AuthMode> options={authOptions} value={authMode} onChange={(value) => setAuthMode(value)} />
                </div>
                <Form form={form} layout="vertical" onFinish={handleAuth} autoComplete="on">
                    <Form.Item name="username" label="账号" rules={[{ required: true, message: "请输入账号" }]}>
                        <Input autoFocus />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
