import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export function AssetsHeader({ active }: { active: "materials" | "cases" }) {
    const { t } = useTranslation();

    return (
        <div className="mx-auto max-w-5xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
            <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
            <nav className="mt-7 flex justify-center gap-8 border-b border-stone-200 text-sm dark:border-stone-800" aria-label={t("assets.title")}>
                {([
                    { key: "materials", to: "/assets", label: t("assets.materialsTab") },
                    { key: "cases", to: "/assets/cases", label: t("assets.casesTab") },
                ] as const).map(({ key, to, label }) => (
                    <Link
                        key={key}
                        to={to}
                        aria-current={active === key ? "page" : undefined}
                        className={`border-b-2 px-4 pb-3 transition ${active === key ? "border-[#217a65] font-semibold text-[#176854] dark:text-[#80d1b9]" : "border-transparent text-stone-500 hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100"}`}
                    >
                        {label}
                    </Link>
                ))}
            </nav>
        </div>
    );
}
