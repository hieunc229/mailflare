"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useEffect, useState } from "react";
import { Plus } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { LicenseRequiredOverlay } from "@/components/license-required-overlay";
import { useCurrentUser } from "@/hooks/use-current-user";
import { defaultTranslator } from "@/lib/i18n/utils";
import { AccountAliases } from "./account-aliases";
import { AccountsTable } from "./accounts-table";
import { DeleteAccountsDialog } from "./delete-accounts-dialog";
import type { Account, AccountAliasDraft, AccountResponse, Domain } from "./types";

async function fetchAccounts(): Promise<AccountResponse> {
	const response = await authFetch("/api/accounts");
	const data = (await response.json()) as AccountResponse;
	if (!response.ok) throw new Error(data.error ?? defaultTranslator("accounts.loadFailed"));
	return data;
}

export default function AccountsPage() {
	const { t } = useLanguage();
	const currentUser = useCurrentUser();
	const canManage = !!currentUser && (currentUser.isPrimaryAdmin || currentUser.canManageUsers);
	const canChooseRole = !!currentUser?.isPrimaryAdmin;
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [domains, setDomains] = useState<Domain[]>([]);
	const [username, setUsername] = useState("");
	const [domainId, setDomainId] = useState("");
	const [role, setRole] = useState<"admin" | "user">("user");
	const [password, setPassword] = useState("");
	const [useAllDomains, setUseAllDomains] = useState(false);
	const [aliases, setAliases] = useState<AccountAliasDraft[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [seats, setSeats] = useState<AccountResponse["seats"] | null>(null);
	const [teamRequired, setTeamRequired] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [restoringId, setRestoringId] = useState<string | null>(null);

	async function loadAccounts() {
		const data = await fetchAccounts();
		setAccounts(data.accounts ?? []);
		setSeats(data.seats ?? null);
	}

	useEffect(() => {
		fetchAccounts().then(async (list) => {
			setAccounts(list.accounts ?? []);
			setSeats(list.seats ?? null);
			const response = await authFetch("/api/domains");
			const data = (await response.json()) as { domains?: Domain[]; error?: string };
			if (!response.ok) throw new Error(data.error ?? t("accounts.domainsFailed"));
			setDomains(data.domains ?? []);
			setDomainId(data.domains?.[0]?.id ?? "");
		}).catch((error) => {
			const text = error instanceof Error ? error.message : t("accounts.loadFailed");
			setTeamRequired(/(pro|team) license/i.test(text) && !/seats/i.test(text));
			setMessage(text);
		}).finally(() => setLoading(false));
	}, []);

	async function createAccount(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setMessage(null);
		try {
			const response = await authFetch("/api/accounts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, domainId, password, role, useAllDomains, aliases: aliases.map(({ domainId, localPart }) => ({ domainId, localPart })) }),
			});
			const data = (await response.json()) as AccountResponse;
			if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("accounts.checkDetails"));
			setUsername("");
			setPassword("");
			setUseAllDomains(false);
			setAliases([]);
			setCreateOpen(false);
			await loadAccounts();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("accounts.createFailed"));
		} finally {
			setSaving(false);
		}
	}

	async function restoreAccount(account: Account) {
		setRestoringId(account.id);
		setMessage(null);
		try {
			const response = await authFetch(`/api/accounts/${account.id}/restore`, { method: "POST" });
			const data = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(data.error ?? t("accounts.restoreFailed"));
			await loadAccounts();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("accounts.restoreFailed"));
		} finally {
			setRestoringId(null);
		}
	}

	const seatsFull = !!seats && seats.limit !== null && seats.used >= seats.limit;

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("accounts.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("accounts.description")}</p>{seats && seats.limit !== null && <p className={`mt-1 text-sm ${seatsFull ? "text-amber-700" : "text-neutral-500"}`}>{t("accounts.seatsUsed", { used: seats.used, limit: seats.limit })}{seatsFull ? ` ${t("accounts.seatsFull")}` : ""}</p>}</div>{!teamRequired && canManage && <Button disabled={seatsFull} className={mobilePrimaryActionClass} onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />{t("accounts.new")}</Button>}</div>
		{message && !createOpen && <p role="alert" className="text-sm text-red-600">{message}</p>}
		<div className="relative">{teamRequired && <LicenseRequiredOverlay required="Pro or Team"><div className="min-h-48 rounded-3xl bg-white" /></LicenseRequiredOverlay>}
			<AccountsTable accounts={accounts} currentUserId={currentUser?.id} isPrimaryAdmin={!!currentUser?.isPrimaryAdmin} loading={loading} selected={selected} onSelectedChange={setSelected} onDeleteSelected={() => setDeleteOpen(true)} onRestore={restoreAccount} restoringId={restoringId} />
		</div>
		<DeleteAccountsDialog open={deleteOpen} onOpenChange={setDeleteOpen} accounts={accounts.filter((account) => selected.has(account.id))} candidates={accounts} onDeleted={async () => { setDeleteOpen(false); setSelected(new Set()); await loadAccounts(); }} />
		<Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[calc(100dvh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto"><DialogHeader><DialogTitle>{t("accounts.addTitle")}</DialogTitle><DialogDescription>{t("accounts.addDescription")}</DialogDescription></DialogHeader><form onSubmit={createAccount}><fieldset disabled={saving} className="space-y-4">
			<div className="space-y-2"><Label htmlFor="account-username">{t("auth.email")}</Label><div className="flex h-10 overflow-hidden rounded-md border border-neutral-200 bg-white"><Input id="account-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("accounts.username")} className="min-w-0 flex-1 rounded-none border-0 shadow-none" required /><span className="flex items-center text-sm text-neutral-500">@</span><Select aria-label={t("accounts.domain")} value={domainId} onChange={(event) => setDomainId(event.target.value)} containerClassName="min-w-0 max-w-[55%] shrink-0 rounded-none border-0 px-0" className="bg-transparent px-3 text-sm" required><option value="">{t("accounts.selectDomain")}</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</Select></div></div>
			<div className="space-y-2"><Label htmlFor="account-password">{t("auth.password")}</Label><Input id="account-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
			{canChooseRole && <div className="space-y-2"><Label htmlFor="account-role">{t("accounts.role")}</Label><Select id="account-role" value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")} containerClassName="h-10 w-full bg-white px-0" className="px-3 text-sm"><option value="user">{t("accounts.roleUser")}</option><option value="admin">{t("accounts.roleAdmin")}</option></Select></div>}
			<AccountAliases domains={domains} domainId={domainId} username={username} useAllDomains={useAllDomains} onUseAllDomainsChange={setUseAllDomains} aliases={aliases} onAliasesChange={setAliases} />
			{message && <p role="alert" className="text-sm text-red-600">{message}</p>}<Button type="submit" disabled={saving || !domainId}>{saving ? t("accounts.creating") : t("accounts.create")}</Button>
		</fieldset></form></DialogContent></Dialog>
	</div>;
}
