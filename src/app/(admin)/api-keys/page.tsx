"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { McpAgentInstructions } from "@/components/settings/mcp-agent-instructions";
import { authFetch } from "@/lib/auth/client";
import type { AdminApiKeyScope } from "@/lib/api/scopes-types";
import type { ApiKey } from "./types";
import { ADMIN_KEY_PERMISSIONS, parseApiKeyScopes } from "./utils";

export default function ApiKeysPage() {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<AdminApiKeyScope[]>(["domains"]);
	const [mcpAllowed, setMcpAllowed] = useState(false);
	const [createdMcpAllowed, setCreatedMcpAllowed] = useState(false);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["admin-api-keys"],
		queryFn: async () => {
			const res = await authFetch("/api/admin/api-keys");
			if (!res.ok) throw new Error(t("adminKeys.loadFailed"));
			return (await res.json()) as { apiKeys: ApiKey[] };
		},
	});

	const create = useMutation({
		mutationFn: async () => {
			const res = await authFetch("/api/admin/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.trim(), scopes, mcpAllowed }),
			});
			const json = (await res.json()) as { key?: string; error?: string };
			if (!res.ok || !json.key) throw new Error(typeof json.error === "string" ? json.error : t("apiKeys.createFailed"));
			setNewKey(json.key ?? null);
			setCreatedMcpAllowed(mcpAllowed);
			setCopied(false);
			setName("");
		},
		onSuccess: () => {
			setScopes(["domains"]);
			qc.invalidateQueries({ queryKey: ["admin-api-keys"] });
		},
	});
	const revoke = useMutation({
		mutationFn: async (id: string) => {
			const res = await authFetch(`/api/admin/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!res.ok) throw new Error(t("adminKeys.revokeFailed"));
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-api-keys"] }),
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl md:text-3xl font-medium">{t("admin.section.apiKeysTitle")}</h1>
				<Dialog open={createOpen} onOpenChange={(open) => { if (create.isPending) return; setCreateOpen(open); if (!open) { setNewKey(null); setCopied(false); } }}>
					<DialogTrigger asChild>
						<Button className={mobilePrimaryActionClass}>
							<Plus className="h-4 w-4" />
							{t("apiKeys.new")}
						</Button>
					</DialogTrigger>
					<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>{newKey ? t("apiKeys.createdTitle") : t("apiKeys.createTitle")}</DialogTitle>
							<DialogDescription>{newKey ? t("apiKeys.copyNow") : t("apiKeys.nameAndAccess")}</DialogDescription>
						</DialogHeader>
						{!newKey && <div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="admin-key-name">{t("apiKeys.keyName")}</Label>
							<Input id="admin-key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t("adminKeys.namePlaceholder")} />
						</div>
						<label className="flex items-start gap-3 text-sm"><Checkbox checked={mcpAllowed} onChange={(event) => setMcpAllowed(event.target.checked)} /><span><strong>{t("apiKeys.allowMcp")}</strong><span className="mt-1 block text-neutral-500">{t("adminKeys.allowMcpHint")}</span></span></label>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t("apiKeys.permissions")}</legend>
							<div className="space-y-2">
								{ADMIN_KEY_PERMISSIONS.map((scope) => (
									<label key={scope.value} className="flex items-start gap-3 text-sm">
										<Checkbox
											checked={scopes.includes(scope.value)}
											className="mt-1"
											onChange={(event) =>
												setScopes((current) =>
													event.target.checked
														? [...current, scope.value]
														: current.filter((item) => item !== scope.value),
												)
											}
										/>
										<span><strong>{t(scope.labelKey)}</strong><span className="block text-neutral-500">{t(scope.descriptionKey)}</span></span>
									</label>
								))}
							</div>
						</fieldset>
						{create.isError && (
							<p role="alert" className="text-sm text-red-600">{(create.error as Error).message}</p>
						)}
						<Button
							onClick={() => create.mutate()}
							disabled={!name.trim() || scopes.length === 0 || create.isPending}
						>
							{create.isPending ? t("accounts.creating") : t("adminKeys.createKey")}
						</Button>
						</div>}
						{newKey && <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4"><code className="block break-all rounded bg-white p-2 text-xs">{newKey}</code>{createdMcpAllowed && <McpAgentInstructions mode="admin" apiKey={newKey} />}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(newKey).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? t("common.copied") : t("apiKeys.copyKey")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setCreateOpen(false); setNewKey(null); setCopied(false); }}>{t("common.done")}</Button></div></div>}
					</DialogContent>
				</Dialog>
			</div>
			<section className="space-y-3">
				{revoke.isError && <p role="alert" className="text-sm text-red-600">{revoke.error.message}</p>}
				{isLoading && (
					<SectionRowSkeleton />
				)}
				{!isLoading && (data?.apiKeys ?? []).length === 0 && (
					<p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">
						{t("apiKeys.none")}
					</p>
				)}
				<List>
					{(data?.apiKeys ?? []).map((key) => (
						<ListRow
							key={key.id}
							className="px-5 py-4"
						>
							<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
								<KeyRound className="h-5 w-5" />
							</span>
							<span className="min-w-0 flex-1 space-y-2">
								<span className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-semibold text-neutral-900">{key.name}</strong>{key.kind === "mcp" && <Badge variant="outline">MCP</Badge>}</span>
								<span className="block truncate no-font-mono text-sm text-neutral-500">{key.prefix}...</span>
								<span className="flex flex-wrap gap-1">
									{parseApiKeyScopes(key.scopes).map((scope) => (
										<Badge key={scope} variant="outline">
											{scope}
										</Badge>
									))}
								</span>
							</span>
						<Button type="button" size="sm" variant="outline" disabled={revoke.isPending} onClick={() => { if (window.confirm(t("apiKeys.revokeConfirm", { name: key.name }))) revoke.mutate(key.id); }}><Trash2 className="h-4 w-4" />{t("common.revoke")}</Button>
						</ListRow>
					))}
				</List>
			</section>
		</div>
	);
}
