"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { LicenseRequiredOverlay } from "@/components/license-required-overlay";
import { List, ListRow } from "@/components/ui/list";
import { useCurrentUser } from "@/hooks/use-current-user";
import { defaultTranslator } from "@/lib/i18n/utils";
import { AccountAliases } from "./account-aliases";
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

	const seatsFull = !!seats && seats.limit !== null && seats.used >= seats.limit;

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("accounts.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("accounts.description")}</p>{seats && seats.limit !== null && <p className={`mt-1 text-sm ${seatsFull ? "text-amber-700" : "text-neutral-500"}`}>{t("accounts.seatsUsed", { used: seats.used, limit: seats.limit })}{seatsFull ? ` ${t("accounts.seatsFull")}` : ""}</p>}</div>{!teamRequired && canManage && <Button disabled={seatsFull} className={mobilePrimaryActionClass} onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />{t("accounts.new")}</Button>}</div>
		<div className="relative">{teamRequired && <LicenseRequiredOverlay required="Pro or Team"><div className="min-h-48 rounded-3xl bg-white" /></LicenseRequiredOverlay>}<List>
			{loading && <p className="text-sm text-neutral-500">{t("common.loading")}</p>}
			{accounts.map((account) => {
				const locked = !currentUser?.isPrimaryAdmin && account.role === "admin" && account.id !== currentUser?.id;
				const row = <>
					<span style={getAvatarColorStyle(account.email)} className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold duration-200">{account.name.charAt(0).toUpperCase()}{account.hasAvatar && <ProgressiveAvatarImage src={`/api/accounts/${account.id}/avatar`} alt="" className="absolute inset-0 h-full w-full object-cover" />}</span>
					<span className="min-w-0"><span className="flex items-center gap-2"><span className="truncate font-semibold text-neutral-900">{account.name}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${account.isPrimaryAdmin ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-600"}`}>{account.isPrimaryAdmin ? t("accounts.primaryAdmin") : t(account.role === "admin" ? "accounts.role.admin" : "accounts.role.user")}</span></span><span className="block truncate text-sm text-neutral-500">{account.email}</span></span>
				</>;
				if (locked) {
					return <ListRow key={account.id} aria-disabled="true" title={t("accounts.lockedAdmin")} className="cursor-not-allowed opacity-50">{row}</ListRow>;
				}
				return <ListRow key={account.id} asChild><Link href={`/accounts/${account.id}`}>{row}</Link></ListRow>;
			})}
		</List></div>
		<Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[calc(100dvh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto"><DialogHeader><DialogTitle>{t("accounts.addTitle")}</DialogTitle><DialogDescription>{t("accounts.addDescription")}</DialogDescription></DialogHeader><form onSubmit={createAccount}><fieldset disabled={saving} className="space-y-4">
			<div className="space-y-2"><Label htmlFor="account-username">{t("auth.email")}</Label><div className="flex h-10 overflow-hidden rounded-md border border-neutral-200 bg-white"><Input id="account-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("accounts.username")} className="min-w-0 flex-1 rounded-none border-0 shadow-none" required /><span className="flex items-center text-sm text-neutral-500">@</span><Select aria-label={t("accounts.domain")} value={domainId} onChange={(event) => setDomainId(event.target.value)} containerClassName="min-w-0 max-w-[55%] shrink-0 rounded-none border-0 px-0" className="bg-transparent px-3 text-sm" required><option value="">{t("accounts.selectDomain")}</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</Select></div></div>
			<div className="space-y-2"><Label htmlFor="account-password">{t("auth.password")}</Label><Input id="account-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
			{canChooseRole && <div className="space-y-2"><Label htmlFor="account-role">{t("accounts.role")}</Label><Select id="account-role" value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")} containerClassName="h-10 w-full bg-white px-0" className="px-3 text-sm"><option value="user">{t("accounts.roleUser")}</option><option value="admin">{t("accounts.roleAdmin")}</option></Select></div>}
			<AccountAliases domains={domains} domainId={domainId} username={username} useAllDomains={useAllDomains} onUseAllDomainsChange={setUseAllDomains} aliases={aliases} onAliasesChange={setAliases} />
			{message && <p role="alert" className="text-sm text-red-600">{message}</p>}<Button type="submit" disabled={saving || !domainId}>{saving ? t("accounts.creating") : t("accounts.create")}</Button>
		</fieldset></form></DialogContent></Dialog>
	</div>;
}
