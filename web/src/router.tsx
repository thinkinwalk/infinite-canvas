import { createBrowserRouter, Navigate, Outlet, useLocation, useSearchParams } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CasesPage from "@/pages/cases";
import CreatorCasesPage from "@/pages/cases/creator";
import ProductSetWorkspacePage from "@/pages/cases/product-set-workspace";
import ImageVariationsWorkspacePage from "@/pages/cases/image-variations-workspace";
import AdminPage from "@/pages/admin";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import CreatePage from "@/pages/create";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import RegisterPage from "@/pages/register";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/create", element: <CreatePage /> },
            { path: "/create-preview", element: <CreateRedirect /> },
            { path: "/home", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/cases", element: <CasesPage /> },
            { path: "/ipcheck", element: <CasesPage /> },
            { path: "/cases/product-listing-set", element: <ProductSetWorkspacePage /> },
            { path: "/cases/image-variations", element: <ImageVariationsWorkspacePage /> },
            { path: "/image-creation", element: <ProductSetEntry /> },
            { path: "/assets/cases", element: <CreatorCasesPage /> },
            { path: "/creator/cases", element: <Navigate to="/assets/cases" replace /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
            { path: "/register", element: <RegisterPage /> },
        ],
    },
    { path: "/admin/*", element: <AdminPage /> },
    { path: "*", element: <NotFound /> },
]);

function ProductSetEntry() {
    const [params] = useSearchParams();
    return params.get("tool") === "product-listing-set" ? <ProductSetWorkspacePage /> : <Navigate to="/image" replace />;
}

function CreateRedirect() {
    const { search, hash } = useLocation();
    return <Navigate to={`/create${search}${hash}`} replace />;
}
