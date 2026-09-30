import { Drawer } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileText, Grid2X2, Image as ImageIcon, Images, Video } from "lucide-react";

import { createToolGroups } from "@/constant/create-catalog";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    pathname: string;
    onClose: () => void;
};

export function MobileNavDrawer({ open, pathname, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const location = useLocation();
    const linkClass = "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition hover:bg-stone-100 hover:text-stone-950 dark:hover:bg-stone-800 dark:hover:text-stone-100";
    const activeHref = `${pathname}${location.search}`;

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="lg:hidden">
            <div className="space-y-5">
                <div>
                    <Link to="/image" onClick={onClose} className={cn(linkClass, pathname === "/image" || pathname.startsWith("/cases") ? "bg-[#e2f2ed] font-semibold text-[#176854] dark:bg-[#17483b] dark:text-[#a3e2cc]" : "text-stone-600 dark:text-stone-300")}>
                        <ImageIcon className="size-4" />
                        图片制作
                    </Link>
                    <Link to="/video" onClick={onClose} className={cn(linkClass, pathname === "/video" ? "bg-[#e2f2ed] font-semibold text-[#176854] dark:bg-[#17483b] dark:text-[#a3e2cc]" : "text-stone-600 dark:text-stone-300")}>
                        <Video className="size-4" />
                        视频制作
                    </Link>
                    <Link to="/canvas" onClick={onClose} className={cn(linkClass, pathname.startsWith("/canvas") ? "bg-[#e2f2ed] font-semibold text-[#176854] dark:bg-[#17483b] dark:text-[#a3e2cc]" : "text-stone-600 dark:text-stone-300")}>
                        <Grid2X2 className="size-4" />
                        无限画布
                    </Link>
                    {createToolGroups.map((group) => (
                        <div key={group.label} className="mt-4">
                            <div className="mb-1 px-3 text-xs font-semibold text-[#176854] dark:text-[#a3e2cc]">{group.label}</div>
                            {group.items.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <Link
                                        key={item.id}
                                        to={item.href}
                                        onClick={onClose}
                                        aria-current={activeHref === item.href ? "page" : undefined}
                                        className={cn(linkClass, activeHref === item.href ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 dark:text-stone-300")}
                                    >
                                        <Icon className="size-4" />
                                        {item.title}
                                    </Link>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <div className="border-t border-stone-200 pt-3 dark:border-stone-800">
                    <Link to="/assets" onClick={onClose} className={cn(linkClass, pathname === "/assets" || pathname.startsWith("/assets/") ? "font-medium text-stone-950 dark:text-stone-100" : "text-stone-600 dark:text-stone-300")}>
                        <Images className="size-4" />
                        {t("navigation.assets")}
                    </Link>
                    <Link to="/prompts" onClick={onClose} className={cn(linkClass, pathname === "/prompts" ? "font-medium text-stone-950 dark:text-stone-100" : "text-stone-600 dark:text-stone-300")}>
                        <FileText className="size-4" />
                        {t("navigation.prompts")}
                    </Link>
                </div>
            </div>
        </Drawer>
    );
}
