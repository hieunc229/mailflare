"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";

type Settings = { domain: string; defaultHost: string; host: string };

/** Hosted workspaces: the optional second address `<name>.<your domain>` (the default `*.mailflare.co` one always works). */
export function WorkspaceAddressForm() {
	const user = useCurrentUser();
	const [data, setData] = useState<Settings | null>(null);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const enabled = !!user?.managed && !!user.isPrimaryAdmin;

	function apply(s: Settings) {
		setData(s);
		setLabel(s.host !== s.defaultHost && s.host.endsWith(`.${s.domain}`) ? s.host.slice(0, -s.domain.length - 1) : "");
	}
	useEffect(() => {
		if (!enabled) return;
		authFetch("/api/workspace").then(async (r) => { if (r.ok) apply((await r.json()) as Settings); });
	}, [enabled]);
	if (!enabled || !data) return null;

	const current = data.host !== data.defaultHost ? data.host.slice(0, -data.domain.length - 1) : "";
	async function save(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true); setMsg(null);
		const host = label.trim() ? `${label.trim()}.${data!.domain}` : "";
		const res = await authFetch("/api/workspace", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host }) }).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
		if (res?.ok) {
			const fresh = await authFetch("/api/workspace");
			if (fresh.ok) apply((await fresh.json()) as Settings);
			setMsg({ ok: true, text: host ? "Saved. Publish the DNS record on the Domains page; changes can take up to 15 seconds to apply." : "Saved. Only the default address is used now." });
		} else setMsg({ ok: false, text: body?.error ?? "Could not save" });
		setBusy(false);
	}

	return (
		<form onSubmit={save} className="max-w-xl space-y-3 rounded-3xl bg-white p-6">
			<h2 className="text-lg font-medium text-neutral-900">Workspace address</h2>
			<p className="text-sm text-neutral-500">Your workspace opens at <b>{data.defaultHost}</b>. You can also give it an address on your own domain (optional).</p>
			<div className="flex items-center gap-2">
				<Input value={label} placeholder="mail" maxLength={63} autoCapitalize="none" autoCorrect="off" spellCheck={false}
					onChange={(e) => setLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
				<span className="shrink-0 text-sm text-neutral-600">.{data.domain}</span>
			</div>
			{current && <p className="text-xs text-neutral-500">Then add the DNS record on the <Link href="/domains" className="underline">Domains page</Link>.</p>}
			{msg && <p className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
			<Button disabled={busy || label.trim() === current}>{busy ? "Saving…" : "Save"}</Button>
		</form>
	);
}
