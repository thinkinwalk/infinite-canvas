import { lazy, Suspense, type ComponentType } from "react";

export default function dynamic<TProps extends object>(loader: () => Promise<{ default: ComponentType<TProps> }>, _options?: { ssr?: boolean }) {
    const Component = lazy(loader);
    return function DynamicComponent(props: TProps) {
        return (
            <Suspense fallback={null}>
                <Component {...props} />
            </Suspense>
        );
    };
}
