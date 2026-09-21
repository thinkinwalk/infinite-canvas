"use client";

import { FileTextOutlined, GiftOutlined, HomeOutlined, LogoutOutlined, PictureOutlined, SettingOutlined, TransactionOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Card, Flex, Form, Input, Layout, Menu, Spin, Typography, theme } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { adminLayoutStyle } from "@/lib/app-theme";
import { adminLogin, type AuthPayload } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

const adminMenus = [
    { key: "/admin/users", icon: <UserOutlined />, label: "用户管理" },
    { key: "/admin/credit-logs", icon: <TransactionOutlined />, label: "使用日志" },
    { key: "/admin/redemption-codes", icon: <GiftOutlined />, label: "兑换码" },
    { key: "/admin/prompts", icon: <FileTextOutlined />, label: "提示词管理" },
    { key: "/admin/assets", icon: <PictureOutlined />, label: "素材库" },
    { key: "/admin/settings", icon: <SettingOutlined />, label: "系统设置" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
    const { token: antToken } = theme.useToken();
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const logout = useUserStore((state) => state.clearSession);
    const activeKey = adminMenus.find((item) => pathname.startsWith(item.key))?.key || "/admin/users";
    const pageTitle = adminMenus.find((item) => item.key === activeKey)?.label || "用户管理";

    if (!isReady) {
        return (
            <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: antToken.colorBgLayout }}>
                <Spin />
            </div>
        );
    }
    if (!token || user?.role !== "admin") return <AdminLogin />;

    return (
        <Layout hasSider style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgLayout }}>
            <Layout.Sider width={adminLayoutStyle.siderWidth} style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgContainer, borderRight: `1px solid ${antToken.colorBorder}` }}>
                <Flex align="center" gap={12} style={{ height: adminLayoutStyle.brandHeight, padding: "0 20px", borderBottom: `1px solid ${antToken.colorBorderSecondary}` }}>
                    <span aria-hidden style={{ display: "inline-block", width: 30, height: 30, background: antToken.colorText, WebkitMask: "url(/logo.svg) center / contain no-repeat", mask: "url(/logo.svg) center / contain no-repeat" }} />
                    <Typography.Text strong style={{ fontSize: 18, letterSpacing: 0 }}>
                        无限画布
                    </Typography.Text>
                </Flex>
                <Menu
                    mode="inline"
                    selectedKeys={[activeKey]}
                    style={adminLayoutStyle.menu}
                    items={adminMenus.map((item) => ({
                        ...item,
                        label: (
                            <Link href={item.key} style={{ color: "inherit" }}>
                                {item.label}
                            </Link>
                        ),
                        style: adminLayoutStyle.menuItem,
                    }))}
                />
                <Flex vertical gap={8} style={{ position: "absolute", bottom: 0, insetInline: 0, padding: 12, borderTop: `1px solid ${antToken.colorBorder}`, background: antToken.colorBgContainer }}>
                    <Button block icon={<HomeOutlined />} href="/canvas" target="_blank" rel="noreferrer">
                        前往画布
                    </Button>
                    <Button block icon={<LogoutOutlined />} onClick={logout}>
                        退出登录
                    </Button>
                </Flex>
            </Layout.Sider>
            <Layout style={{ background: antToken.colorBgLayout }}>
                <Layout.Header
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: adminLayoutStyle.headerHeight, padding: "0 24px", background: antToken.colorBgContainer, borderBottom: `1px solid ${antToken.colorBorder}` }}
                >
                    <Typography.Title level={5} style={{ margin: 0 }}>
                        {pageTitle}
                    </Typography.Title>
                    <Flex align="center" gap={4}>
                        <VersionReleaseModal />
                        <UserStatusActions showConfig={false} showGitHub />
                    </Flex>
                </Layout.Header>
                <Layout.Content style={{ minHeight: 0, overflow: "auto" }}>{children}</Layout.Content>
            </Layout>
        </Layout>
    );
}

function AdminLogin() {
    const { message } = App.useApp();
    const { token: antToken } = theme.useToken();
    const [form] = Form.useForm<AuthPayload>();
    const [submitting, setSubmitting] = useState(false);
    const setSession = useUserStore((state) => state.setSession);

    async function handleLogin(values: AuthPayload) {
        setSubmitting(true);
        try {
            const session = await adminLogin(values);
            setSession(session.token, session.user);
            form.resetFields();
            message.success("管理员登录成功");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Flex align="center" justify="center" style={{ minHeight: "100vh", padding: 24, background: antToken.colorBgLayout }}>
            <Card style={{ width: "100%", maxWidth: 420 }}>
                <Flex vertical align="center" gap={8} style={{ marginBottom: 24 }}>
                    <span aria-hidden style={{ display: "inline-block", width: 42, height: 42, background: antToken.colorText, WebkitMask: "url(/logo.svg) center / contain no-repeat", mask: "url(/logo.svg) center / contain no-repeat" }} />
                    <Typography.Title level={3} style={{ margin: 0 }}>
                        管理后台
                    </Typography.Title>
                    <Typography.Text type="secondary">请使用管理员账号登录</Typography.Text>
                </Flex>
                <Form form={form} layout="vertical" onFinish={handleLogin} autoComplete="on" requiredMark={false}>
                    <Form.Item name="username" label="管理员账号" rules={[{ required: true, message: "请输入管理员账号" }]}>
                        <Input autoFocus autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password autoComplete="current-password" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={submitting}>
                        登录后台
                    </Button>
                </Form>
            </Card>
        </Flex>
    );
}
