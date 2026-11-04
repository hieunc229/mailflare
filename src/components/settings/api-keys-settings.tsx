"use client";

import { mobilePrimaryActionAboveNavClass } from "@/components/page-header-utils";
import { useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { formatUserDate } from "@/lib/time/utils";
import { McpAgentInstructions } from "@/components/settings/mcp-agent-instructions";
import type { ApiKeyScope } from "@/lib/api/scopes";
import type { ManagedApiKey, McpKeyScope } from "./api-keys-settings-types";
import { createManagedApiKey, keyPermissions, loadManagedApiKeys, MCP_KEY_SCOPES, revokeManagedApiKey, STANDARD_KEY_SCOPES } from "./api-keys-settings-utils";

export function ApiKeysSettings() {
	const { t } = useLanguage();
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const [keys, setKeys] = useState<ManagedApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [mcpAllowed, setMcpAllowed] = useState(false);
	const [createdMcpAllowed, setCreatedMcpAllowed] = useState(false);
	const [standardScopes, setStandardScopes] = useState<ApiKeyScope[]>(["read"]);
	const [mcpScopes, setMcpScopes] = useState<McpKeyScope[]>(["mcp:read"]);
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const refresh = () => void loadManagedApiKeys().then((items) => { if (!cancelled) { setKeys(items); setError(null); } }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t("apiKeys.loadFailed")); }).finally(() => { if (!cancelled) setLoading(false); });
		refresh();
		window.addEventListener("mailflare:api-keys-changed", refresh);
		return () => { cancelled = true; window.removeEventListener("mailflare:api-keys-changed", refresh); };
	}, [t]);

	async function create(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const secret = await createManagedApiKey({ name: name.trim(), mcpAllowed, scopes: mcpAllowed ? mcpScopes : standardScopes, mailboxIds });
			setNewKey(secret);
			setCreatedMcpAllowed(mcpAllowed);
			setCopied(false);
			setName("");
			setKeys(await loadManagedApiKeys());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("apiKeys.createFailed"));
		} finally { setBusy(false); }
	}

	async function revoke(key: ManagedApiKey) {
		if (!window.confirm(t("apiKeys.revokeConfirm", { name: key.name }))) return;
		setRevokingId(key.id);
		setError(null);
		try {
			await revokeManagedApiKey(key.id);
			setKeys((current) => current.filter((item) => item.id !== key.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("apiKeys.revokeFailed"));
		} finally { setRevokingId(null); }
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t("apiKeys.title")}</h1>
		<Dialog open={createOpen} onOpenChange={(open) => { if (busy) return; setCreateOpen(open); setError(null); if (open && mailboxIds.length === 0) setMailboxIds([selectedMailbox?.id ?? mailboxes[0]?.id].filter((id): id is string => !!id)); if (!open) { setNewKey(null); setCopied(false); } }}>
			<DialogTrigger asChild><Button type="button" className={mobilePrimaryActionAboveNavClass}><Plus className="h-4 w-4" />{t("apiKeys.new")}</Button></DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader><DialogTitle>{newKey ? t("apiKeys.createdTitle") : t("apiKeys.createTitle")}</DialogTitle><DialogDescription>{newKey ? t("apiKeys.copyNow") : t("apiKeys.nameAndAccess")}</DialogDescription></DialogHeader>
		{!newKey && <form onSubmit={(event) => void create(event)} className="space-y-4">
			<div className="space-y-2"><Label htmlFor="managed-key-name">{t("apiKeys.keyName")}</Label><Input id="managed-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder={t("apiKeys.namePlaceholder")} /></div>
			<label className="flex items-start gap-3 text-sm"><Checkbox checked={mcpAllowed} onChange={(event) => setMcpAllowed(event.target.checked)} /><span><strong>{t("apiKeys.allowMcp")}</strong><span className="mt-1 block text-neutral-500">{t("apiKeys.allowMcpHint")}</span></span></label>
			<label className={`flex items-start gap-3 text-sm ${mcpAllowed ? "opacity-50" : ""}`}><Checkbox checked={!mcpAllowed && standardScopes.includes("jmap")} disabled={mcpAllowed} onChange={(event) => setStandardScopes((current) => event.target.checked ? [...current, "jmap"] : current.filter((scope) => scope !== "jmap"))} /><span><strong>{t("apiKeys.allowJmap")}</strong><span className="mt-1 block text-neutral-500">{mcpAllowed ? t("apiKeys.jmapNeedsStandard") : t("apiKeys.jmapHint")}</span></span></label>
			<fieldset className="space-y-2"><legend className="text-sm font-medium">{t("apiKeys.permissions")}</legend>{(mcpAllowed ? MCP_KEY_SCOPES : STANDARD_KEY_SCOPES).map((scope) => <label key={scope.value} className="flex items-start gap-3 py-2 text-sm"><Checkbox checked={mcpAllowed ? mcpScopes.includes(scope.value as McpKeyScope) : standardScopes.includes(scope.value as ApiKeyScope)} onChange={(event) => { if (mcpAllowed) setMcpScopes((current) => event.target.checked ? [...current, scope.value as McpKeyScope] : current.filter((item) => item !== scope.value)); else setStandardScopes((current) => event.target.checked ? [...current, scope.value as ApiKeyScope] : current.filter((item) => item !== scope.value)); }} /><span><strong>{t(scope.labelKey)}</strong><span className="block text-neutral-500">{t(scope.descriptionKey)}</span></span></label>)}</fieldset>
			<fieldset className="space-y-2"><legend className="text-sm font-medium">{t("apiKeys.allowedMailboxes")}</legend>{mailboxes.length === 0 ? <p className="text-sm text-neutral-500">{t("apiKeys.noMailboxes")}</p> : mailboxes.map((mailbox) => <label key={mailbox.id} className="flex items-center gap-3 text-sm"><Checkbox checked={mailboxIds.includes(mailbox.id)} onChange={(event) => setMailboxIds((current) => event.target.checked ? [...current, mailbox.id] : current.filter((id) => id !== mailbox.id))} />{mailbox.localPart}@{mailbox.hostname}</label>)}<p className="text-xs text-neutral-500">{t("apiKeys.aliasHint")}</p></fieldset>
			<Button type="submit" disabled={busy || !name.trim() || (!mailboxIds.length && (mcpAllowed ? mcpScopes.some((scope) => !scope.startsWith("mcp:calendar-")) : standardScopes.some((scope) => !scope.startsWith("calendar:")))) || (mcpAllowed ? !mcpScopes.length : !standardScopes.length)}><KeyRound className="h-4 w-4" />{busy ? t("apiKeys.creating") : t("apiKeys.createTitle")}</Button>
		</form>}
		{newKey && <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4"><code className="block break-all rounded bg-white p-2 text-xs">{newKey}</code>{createdMcpAllowed && <McpAgentInstructions mode="mail" apiKey={newKey} />}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(newKey).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? t("common.copied") : t("apiKeys.copyKey")}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setCreateOpen(false); setNewKey(null); setCopied(false); }}>{t("common.done")}</Button></div></div>}
		{error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
			</DialogContent>
		</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t("apiKeys.description")}</p>
		{error && !createOpen && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && keys.length === 0 && <p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">{t("apiKeys.none")}</p>}
			<List>
				{keys.map((key) => <ListRow key={key.id} className="px-5 py-4">
					<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"><KeyRound className="h-5 w-5" /></span>
					<span className="min-w-0 flex-1 space-y-2">
						<span className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-semibold text-neutral-900">{key.name}</strong>{key.kind === "mcp" && <Badge variant="outline">MCP</Badge>}</span>
						<span className="block truncate no-font-mono text-sm text-neutral-500">{key.prefix}… · {t("apiKeys.createdOn", { date: formatUserDate(key.createdAt, { dateStyle: "short" }) })} · {key.lastUsedAt ? t("apiKeys.lastUsed", { date: formatUserDate(key.lastUsedAt, { dateStyle: "short" }) }) : t("apiKeys.neverUsed")}</span>
						<span className="flex flex-wrap gap-1">{keyPermissions(key).map((scope) => <Badge key={scope} variant="outline">{scope}</Badge>)}</span>
						<span className="block text-xs text-neutral-500">{t("apiKeys.mailboxesLabel", { list: key.mailboxScopeEnabled || key.kind === "mcp" ? key.mailboxIds.map((id) => { const mailbox = mailboxes.find((item) => item.id === id); return mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : id; }).join(", ") || t("common.none") : t("apiKeys.allAccessible") })}</span>
					</span>
					<Button type="button" size="sm" variant="outline" disabled={revokingId === key.id} onClick={() => void revoke(key)}><Trash2 className="h-4 w-4" />{revokingId === key.id ? t("common.revoking") : t("common.revoke")}</Button>
				</ListRow>)}
			</List>
		</section>
	</div>;
}
