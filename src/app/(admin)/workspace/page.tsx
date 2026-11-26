"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import { MoreHorizontal } from "@/components/icons";

type Settings = {
	name: string; status: string; domain: string; defaultHost: string; host: string;
	plan: { tier: string; status: string; periodEnd: number | null } | null;
	cancelAt: number | null;
	limits: Record<string, number | undefined>;
	storageUsed: number;
	billingUrl: string | null;
	upgradeUrl: string | null;
};

const LIMITS: [keyof Settings["limits"], string][] = [
	["users", "Users"], ["mailboxes", "Mailboxes"], ["domains", "Domains"], ["storageBytes", "Storage"],
];
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const size = (bytes: number) => (bytes >= 2 ** 40 ? `${Number((bytes / 2 ** 40).toFixed(1))} TB` : bytes >= 2 ** 30 ? `${Number((bytes / 2 ** 30).toFixed(1))} GB` : `${Math.round(bytes / 2 ** 20)} MB`);

function limit(key: string, value: number | undefined, used?: number) {
	if (value === undefined || value < 0) return key === "storageBytes" && used !== undefined ? `${size(used)} used, unlimited` : "Unlimited";
	if (key !== "storageBytes") return value.toLocaleString();
	return used !== undefined ? `${size(used)} of ${size(value)}` : size(value);
}

/** Hosted workspaces only: the workspace's name, address and plan, managed by its primary administrator. */
export default function WorkspacePage() {
	const user = useCurrentUser();
	const [data, setData] = useState<Settings | null>(null);
	const [name, setName] = useState("");
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!menuOpen) return;
		const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [menuOpen]);
	const [label, setLabel] = useState("");
	const [avail, setAvail] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	function apply(s: Settings) {
		setData(s); setName(s.name); setLabel(s.defaultHost.split(".")[0] ?? ""); setAvail(null);
	}
	useEffect(() => {
		if (!user?.managed) return;
		authFetch("/api/workspace").then(async (r) => { if (r.ok) apply((await r.json()) as Settings); else setMsg({ ok: false, text: "Could not load the workspace" }); });
	}, [user?.managed]);

	const currentLabel = data?.defaultHost.split(".")[0] ?? "";
	useEffect(() => {
		if (!data || label === currentLabel) { setAvail(null); return; }
		if (!label) { setAvail(null); return; }
		let stale = false;
		const timer = setTimeout(async () => {
			const res = await authFetch(`/api/workspace/address?label=${encodeURIComponent(label)}`).catch(() => null);
			if (stale || !res?.ok) return;
			const r = (await res.json()) as { available: boolean; reason?: string };
			setAvail({ ok: r.available, text: r.available ? "Available" : r.reason ?? "Not available" });
		}, 400);
		return () => { stale = true; clearTimeout(timer); };
	}, [label, currentLabel, data]);

	if (!user) return null;
	if (!user.managed || !user.isPrimaryAdmin) return <p className="p-8 text-sm text-neutral-500">Only the workspace owner can open this page.</p>;
	if (!data) return <p className="p-8 text-sm text-neutral-500">Loading…</p>;

	const date = (ts: number) => new Date(ts * 1000).toLocaleDateString();
	const canCancel = (data.status === "active" || data.status === "past_due") && !data.cancelAt && data.plan?.status !== "cancelled";

	const trialEndsAt = data.limits.trialEndsAt;
	const inTrial = data.status === "active" && !data.plan && !!trialEndsAt && trialEndsAt * 1000 > Date.now();
	const trialOver = data.status === "active" && !data.plan && !!data.limits.trialExpired;

	async function cancelPlan() {
		const when = data!.plan?.periodEnd ? `on ${date(data!.plan.periodEnd)}` : "now";
		if (!confirm(`Cancel the plan? Billing stops now and cannot be restarted. The workspace keeps working until it ends ${when}. A week later the workspace and all its mail and files are permanently deleted.`)) return;
		setBusy(true); setMsg(null);
		const res = await authFetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
		if (res?.ok) {
			const fresh = await authFetch("/api/workspace");
			if (fresh.ok) apply((await fresh.json()) as Settings);
			setMsg({ ok: true, text: "Plan cancelled." });
		} else setMsg({ ok: false, text: body?.error ?? "Could not cancel the plan" });
		setBusy(false);
	}

	const labelChanged = label !== currentLabel;
	const base = data.defaultHost.split(".").slice(1).join(".");
	const dirty = name.trim() !== data.name || labelChanged;

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true); setMsg(null);
		const res = await authFetch("/api/workspace", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...(labelChanged ? { label } : {}) }) }).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
		if (res?.ok) {
			const fresh = await authFetch("/api/workspace");
			if (fresh.ok) apply((await fresh.json()) as Settings);
			setMsg({ ok: true, text: "Saved. Name and address changes can take up to 15 seconds to apply." });
		} else setMsg({ ok: false, text: body?.error ?? "Could not save" });
		setBusy(false);
	}

	return (
		<div className="mx-auto w-full max-w-4xl space-y-8 p-4 md:p-8">
			<div>
				<h1 className="text-2xl font-semibold">Workspace</h1>
				<p className="mt-1 text-sm text-neutral-500">Name, address and plan of this workspace.</p>
			</div>

			<section className="space-y-4">
				<div className="flex flex-wrap items-center gap-3">
					<h2 className="text-lg font-medium">Plan</h2>
					<Badge>{data.status.replace("_", " ")}</Badge>
					{data.plan && <span className="text-sm text-neutral-500">{cap(data.plan.tier)}{data.plan.periodEnd ? ` · renews ${new Date(data.plan.periodEnd * 1000).toLocaleDateString()}` : ""}</span>}
					{canCancel && (
						<div ref={menuRef} className="relative ml-auto">
							<Button type="button" variant="outline" aria-label="Plan actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal className="h-4 w-4" /></Button>
							{menuOpen && (
								<div role="menu" className="absolute right-0 z-10 mt-1 min-w-40 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg">
									<button type="button" role="menuitem" disabled={busy} className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={() => { setMenuOpen(false); void cancelPlan(); }}>Cancel plan</button>
								</div>
							)}
						</div>
					)}
				</div>
				<dl className="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
					{LIMITS.map(([key, label]) => (
						<div key={key} className="flex justify-between px-5 py-3 text-sm"><dt className="text-neutral-500">{label}</dt><dd className="font-medium">{limit(key, data.limits[key], key === "storageBytes" ? data.storageUsed : undefined)}</dd></div>
					))}
				</dl>
				{(inTrial || trialOver) && (
					<div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${trialOver ? "bg-red-50 text-red-800" : "bg-blue-50 text-blue-800"}`}>
						<p className="min-w-0 flex-1">{trialOver
							? "Your free trial has ended. Incoming mail is blurred, and sending, adding domains, users and mailboxes are turned off until you upgrade."
							: `Free trial until ${date(trialEndsAt!)}, limited to ${data.limits.domains ?? 1} domain${data.limits.domains === 1 ? "" : "s"} and ${data.limits.emailsPerUserPerDay ?? 20} emails per user per day. Upgrade to lift the limits.`}</p>
						{data.upgradeUrl && <a href={data.upgradeUrl} className="shrink-0 rounded-full bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700">Upgrade</a>}
					</div>
				)}
				{data.cancelAt && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Plan cancelled. This workspace works until {date(data.cancelAt)}. A week later it and all its mail and files are permanently deleted.</p>}
			</section>

			<form onSubmit={save} className="max-w-xl space-y-5">
				<h2 className="text-lg font-medium">General</h2>
				<div className="space-y-1.5">
					<label htmlFor="ws-name" className="text-sm font-medium">Workspace name</label>
					<Input id="ws-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
				</div>
				<div className="space-y-1.5">
					<label htmlFor="ws-label" className="text-sm font-medium">Workspace address</label>
					<div className="flex items-center gap-2">
						<Input id="ws-label" value={label} maxLength={40} autoCapitalize="none" autoCorrect="off" spellCheck={false}
							onChange={(e) => setLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
						<span className="shrink-0 text-sm text-neutral-600">.{base}</span>
					</div>
					{avail && <p className={`text-sm ${avail.ok ? "text-green-700" : "text-red-700"}`}>{avail.text}</p>}
					<p className="text-sm text-neutral-500">The old address stops working once you save. Anyone with a bookmark must use the new one.</p>
				</div>
				{msg && <p className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
				<Button disabled={busy || !dirty || !name.trim() || !label || (labelChanged && avail?.ok === false)}>{busy ? "Saving…" : "Save"}</Button>
			</form>
		</div>
	);
}
