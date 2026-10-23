import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { fetchAdminUsers, type AdminUser } from "@/services/api/admin";
import { createClientAPIKey, fetchClientAPIKeys, revokeClientAPIKey, type ClientAPIKey } from "@/services/api/client-api-keys";
import { useUserStore } from "@/stores/use-user-store";

export function ClientAPIKeysModal({ open, onClose, initialUser }: { open: boolean; onClose: () => void; initialUser?: AdminUser }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const copy = useCopyText();
    const [owner, setOwner] = useState(initialUser);
    const [keyword, setKeyword] = useState("");
    const [name, setName] = useState("");
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const ownerId = isAdmin ? owner?.id : undefined;
    const canLoad = Boolean(token && (!isAdmin || ownerId));
    const canCreate = canLoad && (!isAdmin || (owner?.role === "user" && owner.status === "active"));
    const users = useQuery({
        queryKey: ["admin", "client-key-users", token, keyword],
        queryFn: () => fetchAdminUsers(token, { keyword }),
        enabled: open && isAdmin && Boolean(token),
        retry: false,
    });
    const keys = useQuery({
        queryKey: ["client-api-keys", token, ownerId],
        queryFn: () => fetchClientAPIKeys(token, ownerId),
        enabled: open && canLoad,
        retry: false,
    });
    const owners = (users.data?.items || []).filter((item) => item.role === "user");
    if (owner && !owners.some((item) => item.id === owner.id)) owners.unshift(owner);

    async function create() {
        if (!canCreate || !name.trim()) return;
        setBusy(true);
        try {
            const created = await createClientAPIKey(token, name.trim(), ownerId);
            setSecret(created.api_key);
            setName("");
            await keys.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建失败");
        } finally {
            setBusy(false);
        }
    }

    async function revoke(id: string) {
        if (!canLoad) return;
        setBusy(true);
        try {
            await revokeClientAPIKey(token, id, ownerId);
            setSecret("");
            await keys.refetch();
            message.success("客户端 Key 已撤销");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "撤销失败");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="客户端 API Key" open={open} onCancel={() => { setSecret(""); onClose(); }} footer={null} width={720} destroyOnHidden>
            {isAdmin && <div className="mb-4">
                <label htmlFor="client-key-owner" className="mb-2 block">所属账号</label>
                <Select
                    id="client-key-owner"
                    className="w-full"
                    aria-label="所属账号"
                    placeholder="搜索用户名、昵称或邮箱"
                    showSearch
                    filterOption={false}
                    onSearch={setKeyword}
                    value={ownerId}
                    loading={users.isFetching}
                    disabled={busy || !!secret}
                    options={owners.map((item) => ({ value: item.id, label: `${item.displayName || item.username} (${item.username})${item.role === "admin" ? " · 管理员" : item.status === "ban" ? " · 已禁用" : ""}` }))}
                    onChange={(id) => {
                        setOwner(owners.find((item) => item.id === id));
                        setSecret("");
                        setName("");
                    }}
                />
            </div>}
            {users.isError && isAdmin && <Alert className="mb-4" type="error" title="读取用户失败" description={users.error.message} />}
            {keys.isError && canLoad && <Alert className="mb-4" type="error" title="读取客户端 Key 失败" description={keys.error.message} />}
            <Space.Compact className="mb-4 w-full">
                <Input aria-label="客户端名称" placeholder="客户端名称" value={name} onChange={(event) => setName(event.target.value)} onPressEnter={() => void create()} disabled={!canCreate || busy || !!secret} />
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => void create()} disabled={!canCreate || !name.trim() || !!secret} loading={busy}>创建</Button>
                <Tooltip title="刷新"><Button aria-label="刷新" icon={<RefreshCw className="size-4" />} onClick={() => void keys.refetch()} disabled={!canLoad || busy || keys.isFetching} /></Tooltip>
            </Space.Compact>
            {secret && <div className="mb-4 space-y-2">
                <div role="status">密钥仅显示一次，关闭后无法查看。</div>
                <Space.Compact className="w-full">
                    <Input.Password readOnly value={secret} aria-label="新建客户端密钥" autoComplete="off" />
                    <Tooltip title="复制密钥"><Button aria-label="复制密钥" icon={<Copy className="size-4" />} onClick={() => copy(secret)} /></Tooltip>
                    <Button onClick={() => setSecret("")}>已保存</Button>
                </Space.Compact>
            </div>}
            <Table<ClientAPIKey> rowKey="id" size="small" dataSource={canLoad ? keys.data?.items || [] : []} loading={busy || keys.isFetching} pagination={{ pageSize: 10 }} scroll={{ x: 540 }} columns={[
                { title: "名称", dataIndex: "name", ellipsis: true },
                { title: "前缀", dataIndex: "prefix", render: (value: string) => `${value}…` },
                { title: "状态", render: (_, item) => <Tag color={item.revoked_at ? "default" : "green"}>{item.revoked_at ? "已撤销" : "有效"}</Tag> },
                { title: "创建时间", dataIndex: "created_at", render: (value: string) => new Date(value).toLocaleString() },
                { title: "", width: 52, render: (_, item) => !item.revoked_at && <Popconfirm title="撤销这个客户端 Key？" onConfirm={() => revoke(item.id)} okText="撤销" cancelText="取消"><Tooltip title="撤销"><Button type="text" danger disabled={busy} aria-label={`撤销 ${item.name}`} icon={<Trash2 className="size-4" />} /></Tooltip></Popconfirm> },
            ]} />
        </Modal>
    );
}
