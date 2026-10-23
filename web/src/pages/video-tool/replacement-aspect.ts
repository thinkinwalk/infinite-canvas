export const replacementAspectRatios = (resolution: string) =>
    resolution.replace(/p$/i, "") === "720" ? ["16:9", "9:16"] : ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"];

export function nearestReplacementAspect(ratios: string[], width?: number, height?: number) {
    if (!width || !height) return "";
    return ratios.reduce((best, ratio) => {
        const distance = (value: string) => {
            const [w, h] = value.split(":").map(Number);
            return Math.abs(Math.log(w / h / (width / height)));
        };
        return distance(ratio) < distance(best) ? ratio : best;
    }, ratios[0]);
}
