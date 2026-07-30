"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { App } from "antd";

import { fetchAdminCreditLogs, type AdminCreditLogQuery } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export const defaultCreditLogPageSize = 20;

export function useAdminCreditLogs(filters: AdminCreditLogQuery) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);

    const query = useQuery({
        queryKey: ["admin", "credit-logs", token, filters],
        queryFn: () => fetchAdminCreditLogs(token, filters),
        enabled: Boolean(token),
        retry: false,
    });

    useEffect(() => {
        if (query.isError) {
            const errorMessage = query.error instanceof Error ? query.error.message : "读取日志失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) clearSession();
        }
    }, [clearSession, message, query.error, query.isError]);

    const data = query.data;

    return {
        logs: data?.items || [],
        stats: data?.stats || { consume: 0, refund: 0, net: 0, count: 0 },
        total: data?.total || 0,
        isLoading: query.isFetching,
        refreshLogs: () => query.refetch(),
    };
}
