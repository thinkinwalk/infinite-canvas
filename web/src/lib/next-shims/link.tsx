import { Link as RouterLink } from "react-router-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children?: ReactNode;
};

export default function Link({ href, children, ...props }: LinkProps) {
    if (/^(https?:)?\/\//.test(href) || props.target) {
        return (
            <a href={href} {...props}>
                {children}
            </a>
        );
    }
    return (
        <RouterLink to={href} {...props}>
            {children}
        </RouterLink>
    );
}
