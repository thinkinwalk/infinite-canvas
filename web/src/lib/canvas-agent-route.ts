export function isCanvasAgentRoute(pathname: string) {
    return pathname === "/canvas" || pathname.startsWith("/canvas/");
}
