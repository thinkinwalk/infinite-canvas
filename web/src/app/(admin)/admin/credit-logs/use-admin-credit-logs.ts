"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { deleteAdminCreditLog, fetchAdminCreditLogs, saveAdminCreditLog, type AdminCreditLog, type AdminCreditLogQuery } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export const defaultCreditLogPageSize = 20;

export function useAdminCreditLogs(filters: AdminCreditLogQuery) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);

    const query = useQuery({
        queryKey: ["admin", "credit-logs", token, filters],
        queryFn: () => fetchAdminCreditLogs(token, filters),
        enabled: Boolean(token),
        retry: false,
    });

    const saveMutation = useMutation({
        mutationFn: (log: Partial<AdminCreditLog>) => saveAdminCreditLog(token, log),
        onSuccess: async (_, log) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "credit-logs"] });
            message.success(log.id ? "日志已保存" : "日志已新增");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminCreditLog(token, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "credit-logs"] });
            message.success("日志已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
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
        isLoading: query.isFetching || saveMutation.isPending || deleteMutation.isPending,
        refreshLogs: () => query.refetch(),
        saveLog: (log: Partial<AdminCreditLog>) => saveMutation.mutateAsync(log),
        deleteLog: (id: string) => deleteMutation.mutateAsync(id),
    };
}
