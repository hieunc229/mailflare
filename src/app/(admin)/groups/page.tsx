"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Plus, Users } from "@/components/icons";
import { LicenseRequiredOverlay } from "@/components/license-required-overlay";
import { useLanguage } from "@/components/language-provider";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { GroupSummary, WhoCanPost } from "./types";
import { WhoCanPostField } from "./who-can-post-field";
import { fetchGroups, groupsFetch, isLicenseRequired, isMigrationRequired, jsonInit, postLabel } from "./utils";

const COLUMNS = "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

function CreateGroupDialog({ open, onOpenChange, domains }: { open: boolean; onOpenChange: (open: boolean) => void; domains: { id: string; hostname: string }[] }) {
	const { t } = useLanguage();
	const router = useRouter();
	const qc = useQueryClient();
	const [domainId, setDomainId] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [whoCanPost, setWhoCanPost] = useState<WhoCanPost>("anyone");
	const create = useMutation({
		mutationFn: () => groupsFetch<{ group: GroupSummary }>("/api/groups", t("groups.createFailed"), jsonInit("POST", {
			domainId: domainId || domains[0]?.id,
			localPart: localPart.trim(),
			name: name.trim(),
			...(description.trim() ? { description: description.trim() } : {}),
			whoCanPost,
		})),
		onSuccess: ({ group }) => {
			qc.invalidateQueries({ queryKey: ["groups"] });
			onOpenChange(false);
			setLocalPart("");
			setName("");
			setDescription("");
			setWhoCanPost("anyone");
			router.push(`/groups/${group.id}`);
		},
	});
	const addressError = create.isError ? (create.error as Error).message : null;
	return <Dialog open={open} onOpenChange={(next) => { if (!next) create.reset(); onOpenChange(next); }}>
		<DialogContent className="max-h-[calc(100dvh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
			<DialogHeader><DialogTitle>{t("groups.createTitle")}</DialogTitle><DialogDescription>{t("groups.createDescription")}</DialogDescription></DialogHeader>
			<form className="space-y-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
				<fieldset disabled={create.isPending} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="group-local-part">{t("groups.address")}</Label>
						<div className="flex h-10 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm shadow-neutral-200/50 focus-within:border-blue-600 pointer-coarse:h-11">
							<Input id="group-local-part" value={localPart} onChange={(event) => setLocalPart(event.target.value)} placeholder={t("groups.localPlaceholder")} autoComplete="off" required maxLength={64} aria-invalid={!!addressError} aria-describedby={addressError ? "group-create-error" : undefined} className="h-full min-w-0 flex-1 rounded-none border-0 shadow-none focus-visible:border-0" />
							<span className="flex items-center text-sm text-neutral-500" aria-hidden="true">@</span>
							<Select aria-label={t("accounts.domain")} value={domainId || domains[0]?.id || ""} onChange={(event) => setDomainId(event.target.value)} containerClassName="max-w-[55%] rounded-none border-0 p-0" className="h-full rounded-none border-0 bg-transparent px-3 text-sm text-neutral-700 shadow-none">
								{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}
							</Select>
						</div>
					</div>
					<div className="space-y-2"><Label htmlFor="group-name">{t("common.name")}</Label><Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("groups.namePlaceholder")} required maxLength={100} className="pointer-coarse:h-11" /></div>
					<div className="space-y-2"><Label htmlFor="group-description">{t("groups.descriptionLabel")}</Label><Textarea id="group-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} /></div>
					<WhoCanPostField value={whoCanPost} onChange={setWhoCanPost} />
				</fieldset>
				{addressError && <p id="group-create-error" role="alert" className="text-sm text-red-600">{addressError}</p>}
				<Button type="submit" disabled={create.isPending || !domains.length || !localPart.trim() || !name.trim()} className="pointer-coarse:min-h-11">{create.isPending ? t("accounts.creating") : t("groups.createButton")}</Button>
			</form>
		</DialogContent>
	</Dialog>;
}

function GroupRow({ group }: { group: GroupSummary }) {
	const { t } = useLanguage();
	return <ListRow asChild className={`${COLUMNS} px-5 py-4`}>
		<Link href={`/groups/${group.id}`} className="group min-h-11 transition-colors hover:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
			<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700" aria-hidden="true"><Users className="h-5 w-5" /></span>
			<span className="min-w-0"><span className="block truncate text-sm font-semibold text-neutral-900">{group.name}</span><span className="block truncate no-font-mono text-sm text-neutral-500">{group.address}</span></span>
			<span className="hidden text-sm text-neutral-600 md:block">{t("groups.memberCount", { count: group.memberCount })}</span>
			<span className="hidden text-sm text-neutral-600 md:block">{t(postLabel(group.whoCanPost))}</span>
			<span className="hidden md:block"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${group.disabled ? "bg-neutral-100 text-neutral-600" : "bg-green-600/10 text-green-800"}`}>{group.disabled ? t("accounts.status.disabled") : t("accounts.status.active")}</span></span>
		</Link>
	</ListRow>;
}

export default function GroupsPage() {
	const { t } = useLanguage();
	const [createOpen, setCreateOpen] = useState(false);
	const groups = useQuery({ queryKey: ["groups"], queryFn: () => fetchGroups(t("groups.loadFailed")), retry: false });
	const licenseRequired = isLicenseRequired(groups.error);
	const migrationRequired = isMigrationRequired(groups.error);
	const canCreate = !!groups.data && groups.data.domains.length > 0;
	const rows = groups.data?.groups ?? [];

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<div><h1 className="text-2xl font-medium text-neutral-900 md:text-3xl">{t("groups.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("groups.description")}</p></div>
			{canCreate && <Button className={`${mobilePrimaryActionClass} pointer-coarse:min-h-11`} onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />{t("groups.new")}</Button>}
		</div>
		{licenseRequired && <LicenseRequiredOverlay required="Pro or Team"><div className="min-h-48 rounded-3xl bg-white" /></LicenseRequiredOverlay>}
		{migrationRequired && <p role="alert" className="flex items-start gap-3 rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t("groups.migrationRequired")}</p>}
		{groups.isError && !licenseRequired && !migrationRequired && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-red-50 px-5 py-4 text-sm text-red-700"><span>{(groups.error as Error).message}</span><Button variant="outline" onClick={() => groups.refetch()} className="pointer-coarse:min-h-11">{t("groups.retry")}</Button></div>}
		{groups.isLoading && <div role="status" aria-label={t("common.loading")} className="space-y-1"><SectionRowSkeleton /><SectionRowSkeleton /><SectionRowSkeleton /></div>}
		{groups.data && groups.data.domains.length === 0 && <p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-600">{t("groups.noDomains")} <Link href="/domains" className="font-medium text-blue-700 underline">{t("groups.addDomain")}</Link></p>}
		{groups.data && groups.data.domains.length > 0 && rows.length === 0 && <div className="rounded-3xl bg-white px-6 py-10 text-center"><Users className="mx-auto h-8 w-8 text-neutral-400" aria-hidden="true" /><p className="mx-auto mt-3 max-w-sm text-sm text-neutral-600">{t("groups.empty")}</p><Button className="mt-4 pointer-coarse:min-h-11" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />{t("groups.new")}</Button></div>}
		{rows.length > 0 && <List aria-label={t("groups.title")}>
			<div className={`${COLUMNS} bg-white px-5 py-3 text-xs font-medium uppercase text-neutral-500`}><span className="w-10" /><span>{t("groups.address")}</span><span className="hidden md:block">{t("groups.colMembers")}</span><span className="hidden md:block">{t("groups.whoCanPost")}</span><span className="hidden md:block">{t("accounts.colStatus")}</span></div>
			{rows.map((group) => <GroupRow key={group.id} group={group} />)}
		</List>}
		{groups.data && <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} domains={groups.data.domains} />}
	</div>;
}
