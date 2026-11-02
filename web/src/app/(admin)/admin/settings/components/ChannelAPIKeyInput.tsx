import { EyeInvisibleOutlined, EyeOutlined, LoadingOutlined } from "@ant-design/icons";
import { App, Input } from "antd";
import { useEffect, useRef, useState, type ChangeEventHandler } from "react";

import { fetchChannelAPIKey } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

type Props = {
    id?: string;
    channelId?: number;
    configured?: boolean;
    value?: string;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    placeholder: string;
};

export default function ChannelAPIKeyInput({ channelId, configured, value, onChange, ...props }: Props) {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [visible, setVisible] = useState(false);
    const [savedKey, setSavedKey] = useState("");
    const [loading, setLoading] = useState(false);
    const request = useRef(0);

    useEffect(() => () => { request.current++; }, []);

    const changeVisibility = async (next: boolean) => {
        const current = ++request.current;
        setVisible(next);
        setSavedKey("");
        setLoading(false);
        if (!next || value || !channelId || !configured || !token) return;
        setLoading(true);
        try {
            const key = await fetchChannelAPIKey(token, channelId);
            if (request.current === current) setSavedKey(key);
        } catch (error) {
            if (request.current !== current) return;
            setVisible(false);
            message.error(error instanceof Error ? error.message : "读取密钥失败");
        } finally {
            if (request.current === current) setLoading(false);
        }
    };

    return (
        <Input.Password
            {...props}
            autoComplete="new-password"
            value={value || (visible ? savedKey : "")}
            onChange={(event) => {
                request.current++;
                setLoading(false);
                setSavedKey("");
                onChange?.(event);
            }}
            visibilityToggle={{ visible, onVisibleChange: (next) => void changeVisibility(next) }}
            iconRender={(shown) => loading ? <LoadingOutlined title="正在读取密钥" /> : shown ? <EyeOutlined title="隐藏密钥" /> : <EyeInvisibleOutlined title="查看密钥" />}
        />
    );
}
