"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowLeft, Mail, Trash2, Users, X } from "@/components/icons";
import { LicenseRequiredOverlay } from "@/components/license-required-overlay";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { GroupDetailResponse, GroupMemberView, WhoCanPost } from "../types";
import { WhoCanPostField } from "../who-can-post-field";
import { fetchGroup, fetchGroups, groupsFetch, isLicenseRequired, isMigrationRequired, jsonInit, MAX_EXTERNAL_MEMBERS, MAX_GROUP_MEMBERS } from "../utils";
import { AddMembers } from "./add-members";

function SettingsForm({ detail }: { detail: GroupDetailResponse }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const { group } = detail;
	const domains = useQuery({ queryKey: ["groups", "domains"], queryFn: () => fetchGroups(t("groups.loadFailed")), select: (data) => data.domains });
	const [name, setName] = useState(group.name);
	const [description, setDescription] = useState(group.description ?? "");
	const [localPart, setLocalPart] = useState(group.localPart);
	const [domainId, setDomainId] = useState(group.domainId);
	const [whoCanPost, setWhoCanPost] = useState<WhoCanPost>(group.whoCanPost);
	const [disabled, setDisabled] = useState(group.disabled);
	const save = useMutation({
		mutationFn: () => groupsFetch(`/api/groups/${group.id}`, t("groups.saveFailed"), jsonInit("PATCH", { name: name.trim(), description: description.trim() || null, localPart: localPart.trim(), domainId, whoCanPost, disabled })),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
	});
	const addressChanged = localPart.trim().toLowerCase() !== group.localPart || domainId !== group.domainId;
	return <Card><CardHeader><CardTitle>{t("groups.settings")}</CardTitle></CardHeader><CardContent>
		<form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
			<fieldset disabled={save.isPending} className="space-y-4">
				<div className="space-y-2"><Label htmlFor="group-name">{t("common.name")}</Label><Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} className="pointer-coarse:h-11" /></div>
				<div className="space-y-2"><Label htmlFor="group-description">{t("groups.descriptionLabel")}</Label><Textarea id="group-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} /></div>
				<div className="space-y-2">
					<Label htmlFor="group-local-part">{t("groups.address")}</Label>
					<div className="flex h-10 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm shadow-neutral-200/50 focus-within:border-blue-600 pointer-coarse:h-11">
						<Input id="group-local-part" value={localPart} onChange={(event) => setLocalPart(event.target.value)} required maxLength={64} autoComplete="off" pattern="[a-zA-Z0-9._%+\-]+" title={t("groups.localPartHint")} aria-describedby={addressChanged ? "group-local-hint group-address-hint" : "group-local-hint"} className="h-full min-w-0 flex-1 rounded-none border-0 shadow-none focus-visible:border-0" />
						<span className="flex items-center text-sm text-neutral-500" aria-hidden="true">@</span>
						<Select aria-label={t("accounts.domain")} value={domainId} onChange={(event) => setDomainId(event.target.value)} containerClassName="max-w-[55%] rounded-none border-0 p-0" className="h-full rounded-none border-0 bg-transparent px-3 text-sm text-neutral-700 shadow-none">
							{(domains.data ?? [{ id: group.domainId, hostname: group.hostname }]).map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}
						</Select>
					</div>
					<p id="group-local-hint" className="text-xs text-neutral-500">{t("groups.localPartHint")}</p>
					{addressChanged && <p id="group-address-hint" className="text-xs text-amber-700">{t("groups.addressChangeHint")}</p>}
				</div>
				<WhoCanPostField value={whoCanPost} onChange={setWhoCanPost} />
				<div className="flex items-center gap-2 rounded-xl border border-neutral-200 pr-3">
					{/* A real label: clicking anywhere on the row toggles the switch, which also gives touch a full-height target. */}
					<label htmlFor="group-disabled" className="min-h-11 min-w-0 flex-1 cursor-pointer px-3 py-2 text-sm"><span className="block font-medium text-neutral-900">{t("groups.disable")}</span><span className="block text-neutral-600">{t("groups.disableHint")}</span></label>
					<Switch id="group-disabled" checked={disabled} onCheckedChange={setDisabled} />
				</div>
			</fieldset>
			{save.isError && <p role="alert" className="text-sm text-red-600">{(save.error as Error).message}</p>}
			{save.isSuccess && !save.isPending && <p role="status" className="text-sm text-green-700">{t("common.saved")}</p>}
			<Button type="submit" disabled={save.isPending || !name.trim() || !localPart.trim()} className="pointer-coarse:min-h-11">{save.isPending ? t("common.saving") : t("groups.save")}</Button>
		</form>
	</CardContent></Card>;
}

function MemberRow({ member, groupId }: { member: GroupMemberView; groupId: string }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const remove = useMutation({
		mutationFn: () => groupsFetch(`/api/groups/${groupId}/members/${member.id}`, t("groups.removeFailed"), jsonInit("DELETE")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
	});
	return <li className="flex min-h-14 items-center gap-3 py-2">
		<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-600" aria-hidden="true">{member.kind === "user" ? <Users className="h-4 w-4" /> : <Mail className="h-4 w-4" />}</span>
		<span className="min-w-0 flex-1">
			<span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium text-neutral-900">{member.name}</span><span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{member.kind === "user" ? t("groups.kindUser") : member.kind === "mailbox" ? t("groups.kindMailbox") : t("groups.kindExternal")}</span>{member.suppressed && <span title={t("groups.suppressedHint")} className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">{t("groups.suppressed")}</span>}{member.disabled && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{t("accounts.status.disabled")}</span>}</span>
			<span className="block truncate no-font-mono text-sm text-neutral-500">{member.address}</span>
			{remove.isError && <span role="alert" className="block text-xs text-red-600">{(remove.error as Error).message}</span>}
		</span>
		<Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()} aria-label={t("groups.removeMember", { name: member.name })} className="h-9 w-9 shrink-0 p-0 pointer-coarse:h-11 pointer-coarse:w-11"><X className="h-4 w-4" /></Button>
	</li>;
}

export default function GroupDetailPage() {
	const { t } = useLanguage();
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const qc = useQueryClient();
	const group = useQuery({ queryKey: ["groups", id], queryFn: () => fetchGroup(id, t("groups.loadFailed")), retry: false });
	const remove = useMutation({
		mutationFn: () => groupsFetch(`/api/groups/${id}`, t("groups.deleteFailed"), jsonInit("DELETE")),
		onSuccess: () => { qc.removeQueries({ queryKey: ["groups", id] }); qc.invalidateQueries({ queryKey: ["groups"] }); router.push("/groups"); },
	});
	const licenseRequired = isLicenseRequired(group.error);
	const notFound = group.error && (group.error as { status?: number }).status === 404;

	async function onDelete(address: string) {
		if (await confirmDestructive({ title: t("groups.deleteTitle"), message: t("groups.deleteConfirm", { address }), confirmLabel: t("common.delete") })) remove.mutate();
	}

	const back = <Link href="/groups" className="inline-flex min-h-11 items-center gap-2 text-sm text-blue-700 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t("groups.back")}</Link>;
	if (group.isLoading) return <div className="space-y-6" role="status" aria-label={t("common.loading")}>{back}<Skeleton className="h-8 w-56" /><Skeleton className="h-64 w-full rounded-3xl" /><Skeleton className="h-48 w-full rounded-3xl" /></div>;
	if (licenseRequired) return <div className="space-y-6">{back}<LicenseRequiredOverlay required="Pro or Team"><div className="min-h-48 rounded-3xl bg-white" /></LicenseRequiredOverlay></div>;
	if (!group.data) {
		return <div className="space-y-6">{back}<div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-red-50 px-5 py-4 text-sm text-red-700"><span>{notFound ? t("groups.notFound") : isMigrationRequired(group.error) ? t("groups.migrationRequired") : (group.error as Error)?.message}</span>{!notFound && <Button variant="outline" onClick={() => group.refetch()} className="pointer-coarse:min-h-11">{t("groups.retry")}</Button>}</div></div>;
	}
	const { group: info, members } = group.data;
	const full = members.length >= MAX_GROUP_MEMBERS;
	const externalCount = members.filter((member) => member.kind === "external").length;
	return <div className="space-y-6">
		{back}
		<div><h1 className="text-2xl font-medium text-neutral-900 md:text-3xl">{info.name}</h1><p className="mt-1 break-all text-sm text-neutral-500">{info.address}{info.disabled && <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">{t("accounts.status.disabled")}</span>}</p></div>
		<SettingsForm key={info.id} detail={group.data} />
		<Card><CardHeader><CardTitle>{t("groups.members")}</CardTitle><CardDescription>{t("groups.memberLimitCount", { count: members.length, max: MAX_GROUP_MEMBERS })}</CardDescription></CardHeader><CardContent className="space-y-5">
			{externalCount > 0 && !info.canSend && <p role="alert" className="flex items-start gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("groups.cannotSend", { hostname: info.hostname })}</p>}
			{externalCount > 0 && <p role="note" className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-700">{t("groups.externalCostNote", { count: externalCount, max: MAX_EXTERNAL_MEMBERS })}</p>}
			<AddMembers groupId={info.id} disabled={full} memberAddresses={members.map((member) => member.address)} externalFull={externalCount >= MAX_EXTERNAL_MEMBERS} />
			{members.length === 0
				? <p role="status" className="flex items-start gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("groups.noMembers")}</p>
				: <ul aria-label={t("groups.members")} className="divide-y divide-neutral-100">{members.map((member) => <MemberRow key={member.id} member={member} groupId={info.id} />)}</ul>}
		</CardContent></Card>
		<Card><CardHeader><CardTitle>{t("groups.dangerZone")}</CardTitle><CardDescription>{t("groups.deleteHint")}</CardDescription></CardHeader><CardContent>
			{remove.isError && <p role="alert" className="mb-3 text-sm text-red-600">{(remove.error as Error).message}</p>}
			<Button variant="destructive" disabled={remove.isPending} onClick={() => onDelete(info.address)} className="pointer-coarse:min-h-11"><Trash2 className="h-4 w-4" />{t("groups.delete")}</Button>
		</CardContent></Card>
	</div>;
}
