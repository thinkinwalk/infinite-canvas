"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import {
    createAdminRedemptionCodes,
    deleteAdminRedemptionCode,
    deleteInvalidAdminRedemptionCodes,
    fetchAdminRedemptionCodes,
    updateAdminRedemptionCodeStatus,
    type AdminRedemptionCode,
    type CreateAdminRedemptionCodesRequest,
} from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export function useAdminRedemptionCodes() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [keyword, setKeyword] = useState("");
    const [status, setStatus] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const query = useQuery({
        queryKey: ["admin", "redemption-codes", token, keyword, status, page, pageSize],
        queryFn: () => fetchAdminRedemptionCodes(token, { keyword, type: status, page, pageSize }),
        enabled: Boolean(token),
        retry: false,
    });

    const createMutation = useMutation({
        mutationFn: (payload: CreateAdminRedemptionCodesRequest) => createAdminRedemptionCodes(token, payload),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "redemption-codes"] });
            message.success("兑换码已生成");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "生成失败"),
    });

    const statusMutation = useMutation({
        mutationFn: ({ id, nextStatus }: { id: string; nextStatus: "enabled" | "disabled" }) => updateAdminRedemptionCodeStatus(token, id, nextStatus),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "redemption-codes"] });
            message.success("状态已更新");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "更新失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminRedemptionCode(token, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "redemption-codes"] });
            message.success("兑换码已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    const cleanMutation = useMutation({
        mutationFn: () => deleteInvalidAdminRedemptionCodes(token),
        onSuccess: async (rows) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "redemption-codes"] });
            message.success(`已清理 ${rows} 个无效兑换码`);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "清理失败"),
    });

    useEffect(() => {
        if (query.isError) {
            const errorMessage = query.error instanceof Error ? query.error.message : "读取兑换码失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) clearSession();
        }
    }, [clearSession, message, query.error, query.isError]);

    const updateFilters = (next: Partial<{ keyword: string; status: string; page: number; pageSize: number }>) => {
        const queryState = { keyword, status, page, pageSize, ...next };
        if (next.keyword !== undefined || next.status !== undefined || next.pageSize !== undefined) queryState.page = 1;
        setKeyword(queryState.keyword);
        setStatus(queryState.status);
        setPage(queryState.page);
        setPageSize(queryState.pageSize);
    };

    const data = query.data;

    return {
        codes: data?.items || [],
        keyword,
        status,
        page,
        pageSize,
        total: data?.total || 0,
        isLoading: query.isFetching || createMutation.isPending || statusMutation.isPending || deleteMutation.isPending || cleanMutation.isPending,
        searchCodes: (value = keyword, nextStatus = status) => updateFilters({ keyword: value, status: nextStatus }),
        changePage: (value: number) => updateFilters({ page: value }),
        changePageSize: (value: number) => updateFilters({ pageSize: value }),
        resetFilters: () => updateFilters({ keyword: "", status: "", page: 1, pageSize: defaultPageSize }),
        refreshCodes: () => query.refetch(),
        createCodes: (payload: CreateAdminRedemptionCodesRequest) => createMutation.mutateAsync(payload),
        updateStatus: (id: string, nextStatus: "enabled" | "disabled") => statusMutation.mutateAsync({ id, nextStatus }),
        deleteCode: (id: string) => deleteMutation.mutateAsync(id),
        cleanInvalid: () => cleanMutation.mutateAsync(),
    };
}

export function isAdminRedemptionCodeExpired(code: AdminRedemptionCode) {
    return code.status === "enabled" && Boolean(code.expiresAt) && new Date(code.expiresAt).getTime() < Date.now();
}
