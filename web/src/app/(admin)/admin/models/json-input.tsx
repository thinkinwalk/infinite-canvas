import { useEffect, useState } from "react";
import { Input } from "antd";

export function JsonInput({ id, value, onChange, rows = 5 }: { id?: string; value?: unknown; onChange?: (value: unknown) => void; rows?: number }) {
    const [text, setText] = useState(() => typeof value === "string" ? value : JSON.stringify(value || {}, null, 2));
    useEffect(() => {
        if (typeof value !== "string") setText(JSON.stringify(value || {}, null, 2));
    }, [value]);
    return <Input.TextArea id={id} rows={rows} value={text} onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try { onChange?.(JSON.parse(next)); } catch { onChange?.(next); }
    }} />;
}

export const jsonObjectRules = [{ validator: (_: unknown, value: unknown) => value === undefined || value === null || typeof value === "object" && !Array.isArray(value) ? Promise.resolve() : Promise.reject(new Error("请输入有效的 JSON 对象")) }];
