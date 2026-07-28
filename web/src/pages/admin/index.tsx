import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import AdminLayout from "@/app/(admin)/admin/layout";
import AdminAssetsPage from "@/app/(admin)/admin/assets/page";
import AdminCreditLogsPage from "@/app/(admin)/admin/credit-logs/page";
import AdminPromptsPage from "@/app/(admin)/admin/prompts/page";
import AdminRedemptionCodesPage from "@/app/(admin)/admin/redemption-codes/page";
import AdminSettingsPage from "@/app/(admin)/admin/settings/page";
import AdminUsersPage from "@/app/(admin)/admin/users/page";

export default function AdminPage() {
    const location = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        if (location.pathname === "/admin") navigate("/admin/users", { replace: true });
    }, [location.pathname, navigate]);

    return <AdminLayout>{adminChild(location.pathname)}</AdminLayout>;
}

function adminChild(pathname: string) {
    if (pathname.startsWith("/admin/settings")) return <AdminSettingsPage />;
    if (pathname.startsWith("/admin/assets")) return <AdminAssetsPage />;
    if (pathname.startsWith("/admin/prompts")) return <AdminPromptsPage />;
    if (pathname.startsWith("/admin/redemption-codes")) return <AdminRedemptionCodesPage />;
    if (pathname.startsWith("/admin/credit-logs")) return <AdminCreditLogsPage />;
    return <AdminUsersPage />;
}
