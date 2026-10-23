import { useEffect, useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip } from "antd";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { createClientAPIKey, fetchClientAPIKeys, revokeClientAPIKey, type ClientAPIKey } from "@/services/api/client-api-keys";
import { useUserStore } from "@/stores/use-user-store";

export function ClientAPIKeysModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const copy = useCopyText();
    const [items, setItems] = useState<ClientAPIKey[]>([]);
    const [name, setName] = useState("");
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);

    async function load() {
        if (!token) return;
        setBusy(true);
        try {
            setItems((await fetchClientAPIKeys(token)).items);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取客户端 Key 失败");
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        setSecret("");
        setItems([]);
        setName("");
        if (open && token) void load();
        // Each account and dialog opening starts with a fresh server list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, token]);

    async function create() {
        if (!token || !name.trim()) return;
        setBusy(true);
        try {
            const created = await createClientAPIKey(token, name.trim());
            setSecret(created.api_key);
            setName("");
            setItems((current) => [created.key, ...current]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建失败");
        } finally {
            setBusy(false);
        }
    }

    async function revoke(id: string) {
        if (!token) return;
        setBusy(true);
        try {
            await revokeClientAPIKey(token, id);
            setSecret("");
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "撤销失败");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="客户端 API Key" open={open} onCancel={() => { setSecret(""); onClose(); }} footer={null} width={720} destroyOnHidden>
            <Space.Compact className="mb-4 w-full">
                <Input aria-label="客户端名称" placeholder="客户端名称" value={name} onChange={(event) => setName(event.target.value)} onPressEnter={() => void create()} disabled={busy || !!secret} />
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => void create()} disabled={!name.trim() || !!secret} loading={busy}>创建</Button>
                <Tooltip title="刷新"><Button aria-label="刷新" icon={<RefreshCw className="size-4" />} onClick={() => void load()} disabled={busy} /></Tooltip>
            </Space.Compact>
            {secret && <div className="mb-4 space-y-2">
                <div role="status">密钥仅显示一次，关闭后无法查看。</div>
                <Space.Compact className="w-full">
                    <Input.Password readOnly value={secret} aria-label="新建客户端密钥" autoComplete="off" />
                    <Tooltip title="复制密钥"><Button aria-label="复制密钥" icon={<Copy className="size-4" />} onClick={() => copy(secret)} /></Tooltip>
                    <Button onClick={() => setSecret("")}>已保存</Button>
                </Space.Compact>
            </div>}
            <Table<ClientAPIKey> rowKey="id" size="small" dataSource={items} loading={busy} pagination={{ pageSize: 10 }} scroll={{ x: 540 }} columns={[
                { title: "名称", dataIndex: "name", ellipsis: true },
                { title: "前缀", dataIndex: "prefix", render: (value: string) => `${value}…` },
                { title: "状态", render: (_, item) => <Tag color={item.revoked_at ? "default" : "green"}>{item.revoked_at ? "已撤销" : "有效"}</Tag> },
                { title: "创建时间", dataIndex: "created_at", render: (value: string) => new Date(value).toLocaleString() },
                { title: "", width: 52, render: (_, item) => !item.revoked_at && <Popconfirm title="撤销这个客户端 Key？" onConfirm={() => revoke(item.id)} okText="撤销" cancelText="取消"><Tooltip title="撤销"><Button type="text" danger aria-label={`撤销 ${item.name}`} icon={<Trash2 className="size-4" />} /></Tooltip></Popconfirm> },
            ]} />
        </Modal>
    );
}
