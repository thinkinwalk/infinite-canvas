import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";

export default function RegisterPage() {
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);

    useEffect(() => {
        if (user) navigate("/", { replace: true });
    }, [navigate, user]);

    return (
        <main className="flex h-full items-center justify-center bg-background px-6 py-10 text-foreground">
            <section className="w-full max-w-md border border-stone-200 bg-background p-8 text-center dark:border-stone-800">
                <h1 className="text-2xl font-semibold">注册账号</h1>
                <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">请在弹出的注册窗口中完成账号注册。</p>
            </section>
        </main>
    );
}
