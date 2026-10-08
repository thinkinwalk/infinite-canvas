import { useEffect, useRef, useState } from "react";
import { ChevronDown, Grid2X2, Image as ImageIcon, UserRound, Video, type LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { createToolGroups, videoToolGroups, type CatalogItem } from "@/constant/create-catalog";

type ToolGroup = {
    label: string;
    items: CatalogItem[];
};

type WorkbenchMenuProps = {
    label: string;
    href: string;
    icon: LucideIcon;
    groups?: ToolGroup[];
    active?: boolean;
};

function WorkbenchMenu({ label, href, icon: Icon, groups = [], active = false }: WorkbenchMenuProps) {
    const [open, setOpen] = useState(false);
    const location = useLocation();
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasMenu = groups.length > 0;
    const currentHref = `${location.pathname}${location.search}`;
    const columns = [groups.filter((_, index) => index % 2 === 0), groups.filter((_, index) => index % 2 === 1)];

    const cancelClose = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    };

    const scheduleClose = () => {
        cancelClose();
        closeTimerRef.current = setTimeout(() => {
            setOpen(false);
            closeTimerRef.current = null;
        }, 120);
    };

    useEffect(() => {
        setOpen(false);
    }, [location.pathname, location.search]);
    useEffect(() => () => cancelClose(), []);
    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
                triggerRef.current?.focus();
            }
        };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    const entry = (item: CatalogItem) => {
        const Icon = item.icon;
        const activeItem = currentHref === item.href;
        return (
            <Link
                key={item.id}
                to={item.href}
                onClick={() => setOpen(false)}
                aria-current={activeItem ? "page" : undefined}
                className={`flex min-h-10 items-center gap-2 rounded px-2 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#217a65] ${activeItem ? "bg-[#e7f4ee] font-medium text-[#176854] dark:bg-[#29463c] dark:text-[#b4ead5]" : "text-[#263238] hover:bg-[#edf5f1] hover:text-[#176854] dark:text-stone-200 dark:hover:bg-[#263b34] dark:hover:text-[#a3e2cc]"}`}
            >
                <Icon className={`size-4 shrink-0 ${activeItem ? "text-[#217a65] dark:text-[#a3e2cc]" : "text-[#699688] dark:text-[#8bcab6]"}`} />
                <span className="min-w-0 flex-1">{item.title}</span>
            </Link>
        );
    };

    return (
        <div
            ref={rootRef}
            className="relative flex h-full shrink-0 items-stretch"
            onMouseEnter={() => {
                if (!hasMenu) return;
                cancelClose();
                setOpen(true);
            }}
            onMouseLeave={hasMenu ? scheduleClose : undefined}
            onFocus={() => {
                if (!hasMenu) return;
                cancelClose();
                setOpen(true);
            }}
        >
            <Link
                to={href}
                onClick={() => setOpen(false)}
                className={`flex items-center whitespace-nowrap border-b-2 font-semibold transition ${active ? "border-[#217a65] text-[#176854] dark:text-[#80d1b9]" : "border-transparent text-[#65737a] hover:text-[#182025] dark:text-stone-400 dark:hover:text-white"}`}
            >
                <Icon className="size-4 shrink-0" />
                {label}
            </Link>
            {hasMenu ? (
                <button
                    ref={triggerRef}
                    type="button"
                    aria-expanded={open}
                    aria-controls={`${href.slice(1)}-quick-menu`}
                    onClick={() => setOpen(true)}
                    title={`打开${label}工具菜单`}
                    className={`flex items-center border-b-2 pl-1 font-semibold transition ${active ? "border-[#217a65] text-[#176854] dark:text-[#80d1b9]" : "border-transparent text-[#65737a] hover:text-[#182025] dark:text-stone-400 dark:hover:text-white"}`}
                >
                    <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
            ) : null}
            {open ? (
                <nav
                    id={`${href.slice(1)}-quick-menu`}
                    aria-label={`${label}快捷入口`}
                    className="fixed left-4 right-4 top-16 z-30 max-h-[calc(100dvh-88px)] overflow-y-auto rounded-md border border-[#dce4e1] bg-white shadow-xl sm:absolute sm:left-0 sm:right-auto sm:top-full sm:w-[430px] dark:border-[#3c514a] dark:bg-[#1c2324]"
                >
                    <div className="border-b border-[#e3ebe7] bg-[#f5faf8] px-4 py-3 dark:border-stone-700 dark:bg-[#202e2b]">
                        <h2 className="px-2 text-xs font-semibold text-[#176854] dark:text-[#a3e2cc]">{label}工具</h2>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 p-4 sm:gap-x-5">
                        {columns.map((column, index) => (
                            <div key={index} className="space-y-4">
                                {column.map((group) => (
                                    <div key={group.label} className={group.label === "服装电商" ? "pt-2" : undefined}>
                                        <h3 className="mb-1 px-2 text-xs font-semibold text-[#176854] dark:text-[#a3e2cc]">{group.label}</h3>
                                        {group.items.map((item) => entry(item))}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </nav>
            ) : null}
        </div>
    );
}

export function CreateMenu({ active = true }: { active?: boolean }) {
    const location = useLocation();
    const imageActive = active && (/^\/cases(\/|$)/.test(location.pathname) || location.pathname === "/image");
    const videoActive = active && (/^\/video(\/|$)/.test(location.pathname));
    const digitalHumanActive = active && location.pathname === "/digital-human";
    const canvasActive = active && /^\/canvas(\/|$)/.test(location.pathname);

    return (
        <>
            <WorkbenchMenu label="图片制作" href="/image" icon={ImageIcon} groups={createToolGroups} active={imageActive} />
            <WorkbenchMenu label="视频制作" href="/video" icon={Video} groups={videoToolGroups} active={videoActive} />
            <WorkbenchMenu label="数字人" href="/digital-human" icon={UserRound} active={digitalHumanActive} />
            <WorkbenchMenu label="无限画布" href="/canvas" icon={Grid2X2} active={canvasActive} />
        </>
    );
}




