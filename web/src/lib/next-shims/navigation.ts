import { useLocation, useNavigate } from "react-router-dom";

export function usePathname() {
    return useLocation().pathname;
}

export function useRouter() {
    const navigate = useNavigate();
    return {
        push: (href: string) => navigate(href),
        replace: (href: string) => navigate(href, { replace: true }),
    };
}

export function redirect(href: string): never {
    throw new Response(null, { status: 302, headers: { Location: href } });
}
