import { useState, type CSSProperties } from "react";
import { App, Form, Input, Modal, Segmented } from "antd";
import { BookOpen, Keyboard, LogIn, LogOut, Puzzle, Settings2, Shield, UserRound } from "lucide-react";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { canvasThemes } from "@/lib/canvas-theme";
import { adminLogin, type AuthPayload } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    showGitHub?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

type AuthMode = "login" | "register" | "admin";

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { message } = App.useApp();
    const [authOpen, setAuthOpen] = useState(false);
    const [authMode, setAuthMode] = useState<AuthMode>("login");
    const [submitting, setSubmitting] = useState(false);
    const [form] = Form.useForm<AuthPayload>();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth.allowRegister ?? true);
    const user = useUserStore((state) => state.user);
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const setSession = useUserStore((state) => state.setSession);
    const clearSession = useUserStore((state) => state.clearSession);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const authOptions: Array<{ label: string; value: AuthMode }> = [
        { label: "登录", value: "login" },
        ...(allowRegister ? [{ label: "注册", value: "register" as const }] : []),
        { label: "后台", value: "admin" },
    ];

    async function handleAuth(values: AuthPayload) {
        setSubmitting(true);
        try {
            if (authMode === "admin") {
                const session = await adminLogin(values);
                setSession(session.token, session.user);
            } else if (authMode === "register") {
                await register(values);
            } else {
                await login(values);
            }
            setAuthOpen(false);
            form.resetFields();
            message.success(authMode === "admin" ? "管理员登录成功" : "登录成功");
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

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {user ? (
                <>
                    {user.role === "admin" ? (
                        <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => window.location.assign("/admin")} aria-label="后台" title="后台">
                            <Shield className="size-4" />
                        </button>
                    ) : null}
                    <button type="button" className={naturalIconClass} style={iconStyle} aria-label={user.displayName || user.username} title={`${user.displayName || user.username}${typeof user.credits === "number" ? ` · ${user.credits} 点` : ""}`}>
                        <UserRound className="size-4" />
                    </button>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={clearSession} aria-label="退出登录" title="退出登录">
                        <LogOut className="size-4" />
                    </button>
                </>
            ) : (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openAuth("login")} aria-label="登录" title="登录 / 后台">
                    <LogIn className="size-4" />
                </button>
            )}
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label="节点插件" title="节点插件">
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label="文档" title="文档">
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            <VersionReleaseModal style={iconStyle} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            <Modal title={authMode === "admin" ? "后台登录" : authMode === "register" ? "注册账号" : "登录账号"} open={authOpen} onCancel={() => setAuthOpen(false)} onOk={() => form.submit()} okText={authMode === "register" ? "注册" : "登录"} cancelText="取消" confirmLoading={submitting} destroyOnHidden>
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
