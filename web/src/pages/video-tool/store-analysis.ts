export function storeAnalysisDisplay(text: string, labels: { id: string; label: string }[]) {
    // Replace only known material tokens for reading; the saved analysis stays intact.
    for (const { id, label } of [...labels].sort((a, b) => b.id.length - a.id.length)) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`(?<![\\w-])(?:图片\\s*\\d+\\s*[|｜·]\\s*)?(?:ID\\s*[=:：]\\s*)?${escaped}(?![\\w-])`, "g"), label);
    }
    return text;
}
