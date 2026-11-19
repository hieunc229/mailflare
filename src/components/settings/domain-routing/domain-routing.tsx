"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Forward, Inbox, Info, Pencil, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoutingRuleSelect } from "./routing-rule-select";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { CardGridSkeleton } from "@/components/page-skeletons";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { canManageDomains } from "@/lib/auth/admin";
import { ClientRequestError } from "@/lib/http/client-error";
import { useSecurityStatus } from "../security-status-store";
import { StepUpDialog } from "../step-up-dialog";
import { MAIL_TYPE_UNSAFE_ACTION } from "@/lib/email/mail-type-rule";
import type { DomainRoutingProps, DomainRule, DomainRuleInput } from "./types";
import {
	ACTION_LABELS,
	MATCH_FIELD_LABELS,
	MATCH_OPERATOR_LABELS,
	createDomainRule,
	deleteDomainRule,
	describeRule,
	emptyRuleInput,
	fetchDomainRules,
	formatLastMatched,
	ruleToInput,
	updateDomainRule,
} from "./utils";

const ACTION_ICONS = {
	store: Inbox,
	forward: Forward,
	reject: Ban,
} as const;

export function DomainRouting({ domain }: DomainRoutingProps = {}) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const { selectedMailbox, isLoading: isMailboxLoading } = useSelectedMailbox();
	const currentUser = useCurrentUser();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<DomainRule | null>(null);
	const [form, setForm] = useState<DomainRuleInput>(emptyRuleInput(""));
	const [error, setError] = useState<string | null>(null);
	const [confirmingForward, setConfirmingForward] = useState(false);
	const { status: securityStatus } = useSecurityStatus();

	const domainId = domain?.id ?? selectedMailbox?.domainId ?? "";
	const mailboxId = selectedMailbox?.id ?? "";
	const isMailType = form.matchField === "mail_type";
	const canManage = !!currentUser && canManageDomains(currentUser);
	const rulesQueryKey = ["domain-rules", domainId] as const;

	const rules = useQuery({
		queryKey: rulesQueryKey,
		enabled: !!domainId && canManage,
		queryFn: () => fetchDomainRules(domainId),
	});

	const hostname = domain?.hostname ?? selectedMailbox?.hostname ?? "";
	const mailboxes = rules.data?.mailboxes ?? [];

	const save = useMutation({
		mutationFn: (stepUpToken?: string) => {
			const payload: DomainRuleInput = { ...form, domainId, keepCopy: form.keepCopy || isMailType, ...(stepUpToken ? { stepUpToken } : {}) };
			return editing
				? updateDomainRule(editing.id, payload)
				: createDomainRule(payload);
		},
		onSuccess: () => {
			setConfirmingForward(false);
			setDialogOpen(false);
			setEditing(null);
			setError(null);
			qc.invalidateQueries({ queryKey: rulesQueryKey });
		},
		// A forward to an outside address asks the user to confirm it is them, then retries.
		onError: (e: Error) => {
			if (e instanceof ClientRequestError && e.code === "verification_failed") {
				setError(null);
				setConfirmingForward(true);
			} else setError(e.message);
		},
	});

	const remove = useMutation({
		mutationFn: (id: string) => deleteDomainRule(id),
		onMutate: () => toggle.reset(),
		onSuccess: () => qc.invalidateQueries({ queryKey: rulesQueryKey }),
	});

	// Switching an outside forward back on needs the same proof as creating it.
	const [togglingRule, setTogglingRule] = useState<DomainRule | null>(null);
	const toggle = useMutation({
		mutationFn: ({ rule, stepUpToken }: { rule: DomainRule; stepUpToken?: string }) =>
			updateDomainRule(rule.id, { ...ruleToInput(rule), enabled: !rule.enabled, ...(stepUpToken ? { stepUpToken } : {}) }),
		onMutate: () => remove.reset(),
		onSuccess: () => {
			setTogglingRule(null);
			qc.invalidateQueries({ queryKey: rulesQueryKey });
		},
		onError: (e: Error, { rule }) => {
			if (e instanceof ClientRequestError && e.code === "verification_failed") setTogglingRule(rule);
		},
	});

	function openCreate() {
		setEditing(null);
		setError(null);
		setForm(emptyRuleInput(domainId));
		setDialogOpen(true);
	}

	function openEdit(rule: DomainRule) {
		setEditing(rule);
		setError(null);
		setForm(ruleToInput(rule));
		setDialogOpen(true);
	}

	const blockRules = (rules.data?.rules ?? []).filter((r) => r.action === "reject");
	const fallbackRules = (rules.data?.rules ?? []).filter((r) => r.action !== "reject");
	if (!canManage) return null;

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<div className="flex items-center gap-2">
						<h2 className="text-2xl font-semibold">{t("routing.title")}</h2>
						<Tooltip label={t("routing.about")}>
							<button type="button" aria-label={t("routing.aboutLabel")} className="text-neutral-400 hover:text-neutral-700">
								<Info className="h-4 w-4" />
							</button>
						</Tooltip>
					</div>
					<p className="mt-1 text-sm text-neutral-500">{t("routing.rulesFor", { host: hostname || t("routing.selectInbox") })}</p>
				</div>
				<div className="flex items-end gap-2">
					<Button onClick={openCreate} disabled={!domainId}>
						<Plus className="h-4 w-4" /> {t("routing.addRoute")}
					</Button>
				</div>
			</div>

			{(!domain && isMailboxLoading) || rules.isLoading ? (
				<CardGridSkeleton />
			) : !domain && !mailboxId ? (
				<Card>
					<CardContent className="pt-6 text-sm text-neutral-500">
						{t("routing.selectInboxFirst")}
					</CardContent>
				</Card>
			) : (
				<div className="space-y-1 overflow-hidden rounded-3xl">
					{(remove.error ?? toggle.error) && (
						<p role="alert" className="bg-white px-6 py-3 text-sm text-red-600">{(remove.error ?? toggle.error)?.message}</p>
					)}
					<RuleSection
						className="rounded-b-lg rounded-t-3xl"
						title={t("routing.blockRules")}
						description={t("routing.blockRulesDescription")}
						rules={blockRules}
						hostname={hostname}
						mailboxes={mailboxes}
						onEdit={openEdit}
						onDelete={(id) => remove.mutate(id)}
						onToggle={(rule) => toggle.mutate({ rule })}
					/>
					<RuleSection
						className="rounded-b-3xl rounded-t-lg"
						title={t("routing.catchAll")}
						description={t("routing.catchAllDescription")}
						rules={fallbackRules}
						hostname={hostname}
						mailboxes={mailboxes}
						onEdit={openEdit}
						onDelete={(id) => remove.mutate(id)}
						onToggle={(rule) => toggle.mutate({ rule })}
					/>
				</div>
			)}

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				{/* The form grows when the action changes, so the dialog must scroll rather than overflow the viewport. */}
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-[560px]">
					<DialogHeader>
						<DialogTitle>{editing ? t("routing.editRule") : t("routing.addRule")}</DialogTitle>
						<DialogDescription>{t("routing.dialogDescription")}</DialogDescription>
					</DialogHeader>

					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							save.mutate(undefined);
						}}
					>
						<div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
						<div className="grid min-w-0 gap-2">
							<Label htmlFor="rule-name">{t("common.name")}</Label>
							<Input
								id="rule-name"
								value={form.name ?? ""}
								placeholder={t("routing.optionalLabel")}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</div>

						<div className="grid min-w-0 gap-2">
							<Label htmlFor="rule-action">{t("routing.action")}</Label>
							<RoutingRuleSelect
								id="rule-action"
								value={form.action}
								onChange={(e) => {
									const action = e.target.value as DomainRuleInput["action"];
									// Forwarding newsletters must keep a copy, or a misjudged message is lost.
									setForm({ ...form, action, keepCopy: action === "forward" && isMailType ? true : form.keepCopy });
								}}
							>
								{Object.entries(ACTION_LABELS).filter(([value]) => !(isMailType && value === "reject")).map(([value, label]) => (
									<option key={value} value={value}>
										{t(label)}
									</option>
								))}
							</RoutingRuleSelect>
						</div>
						</div>

						<div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
							<div className="grid min-w-0 gap-2">
								<Label htmlFor="rule-field">{t("routing.matchOn")}</Label>
								<RoutingRuleSelect
									id="rule-field"
									value={form.matchField}
									onChange={(e) => {
										const matchField = e.target.value as DomainRuleInput["matchField"];
										// "Newsletter or promotional mail" is a yes/no condition: no text to enter.
										// Reject would lose mail, so it is not offered for this condition.
										if (matchField === "mail_type") setForm({ ...form, matchField, matchOperator: "contains", matchValue: "bulk", action: form.action === "reject" ? "store" : form.action, keepCopy: form.action === "forward" ? true : form.keepCopy });
										else setForm({ ...form, matchField, matchValue: form.matchField === "mail_type" ? "" : form.matchValue });
									}}
								>
									{Object.entries(MATCH_FIELD_LABELS).map(([value, label]) => (
										<option key={value} value={value}>
											{t(label)}
										</option>
									))}
								</RoutingRuleSelect>
							</div>
							{form.matchField === "mail_type" ? (
								<p className="text-xs leading-5 text-neutral-500">{t("rules.mailTypeHint")}</p>
							) : (
							<div className="grid min-w-0 gap-2">
								<Label htmlFor="rule-operator">{t("routing.condition")}</Label>
								<RoutingRuleSelect
									id="rule-operator"
									value={form.matchOperator}
									onChange={(e) =>
										setForm({
											...form,
											matchOperator: e.target.value as DomainRuleInput["matchOperator"],
										})
									}
								>
									{Object.entries(MATCH_OPERATOR_LABELS).map(([value, label]) => (
										<option key={value} value={value}>
											{t(label)}
										</option>
									))}
								</RoutingRuleSelect>
							</div>
							)}
						</div>

						<div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
							{form.matchField !== "mail_type" && (
							<div className="grid min-w-0 gap-2">
								<div className="flex items-center gap-2">
									<Label htmlFor="rule-value">{t("routing.matchValue")}</Label>
									<Tooltip label={t("routing.matchAllHint")}>
										<button type="button" aria-label={t("routing.matchAllHint")} className="text-neutral-500"><Info className="h-4 w-4" /></button>
									</Tooltip>
								</div>
								<Input
									id="rule-value"
									required
									value={form.matchValue}
									placeholder={t("routing.matchAllPlaceholder")}
									onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
								/>
							</div>
							)}
							<div className="grid min-w-0 gap-2">
								<div className="flex items-center gap-2">
									<Label htmlFor="rule-priority">{t("routing.priority")}</Label>
									<Tooltip label={t("routing.priorityHint")}>
										<button type="button" aria-label={t("routing.priorityHint")} className="text-neutral-500"><Info className="h-4 w-4" /></button>
									</Tooltip>
								</div>
								<Input
									id="rule-priority"
									type="number"
									min={0}
									max={1000}
									value={form.priority}
									onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
								/>
							</div>
						</div>

						{form.action !== "reject" && (
							<div className={form.action === "forward" ? "grid grid-cols-1 items-end gap-4 sm:grid-cols-2" : "grid min-w-0 gap-2"}>
							<div className="grid min-w-0 gap-2">
								<Label htmlFor="rule-mailbox">
									{form.action === "forward" ? t("routing.keptCopyMailbox") : t("routing.destinationMailbox")}
								</Label>
								<RoutingRuleSelect
									id="rule-mailbox"
									value={form.mailboxId ?? ""}
									onChange={(e) => setForm({ ...form, mailboxId: e.target.value || null })}
								>
									<option value="">{t("routing.selectMailbox")}</option>
									{mailboxes.map((mailbox) => (
										<option key={mailbox.id} value={mailbox.id}>
											{mailbox.localPart}@{hostname}
											{mailbox.disabled ? t("routing.disabledSuffix") : ""}
										</option>
									))}
								</RoutingRuleSelect>
							</div>
							{form.action === "forward" && (
								<div className="grid min-w-0 gap-2">
									<Label htmlFor="rule-forward">{t("routing.forwardTo")}</Label>
									<Input
										id="rule-forward"
										type="email"
										required
										value={form.forwardTo ?? ""}
										onChange={(e) => setForm({ ...form, forwardTo: e.target.value })}
									/>
								</div>
							)}
							</div>
						)}

						{form.action === "forward" && (
							<div className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2">
								<div>
									<div className="flex items-center gap-2">
										<p className="text-sm font-medium">{t("routing.keepCopy")}</p>
										<Tooltip label={t("routing.keepCopyHint")}>
											<button type="button" aria-label={t("routing.keepCopyHint")} className="text-neutral-500"><Info className="h-4 w-4" /></button>
										</Tooltip>
									</div>
								</div>
								<Switch
									checked={form.keepCopy || isMailType}
									disabled={isMailType}
									onCheckedChange={(keepCopy) => setForm({ ...form, keepCopy })}
									aria-label={t("routing.keepCopy")}
								/>
							</div>
						)}

						{form.action === "reject" && (
							<div className="grid min-w-0 gap-2">
								<Label htmlFor="rule-reason">{t("routing.rejectReason")}</Label>
								<Input
									id="rule-reason"
									value={form.rejectReason ?? ""}
									placeholder={t("routing.rejectPlaceholder")}
									onChange={(e) => setForm({ ...form, rejectReason: e.target.value })}
								/>
							</div>
						)}

						{error && <p role="alert" className="text-sm text-red-600">{error === MAIL_TYPE_UNSAFE_ACTION ? t("rules.mailTypeUnsafeAction") : error}</p>}

						<div className="flex justify-end gap-2 border-t border-neutral-200 pt-4">
							<Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
								{t("common.cancel")}
							</Button>
							<Button type="submit" disabled={save.isPending}>
								{editing ? t("rules.saveChanges") : t("rules.create")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			<StepUpDialog
				open={confirmingForward}
				hasPassword={securityStatus?.passwordSet ?? true}
				hasPasskey={(securityStatus?.passkeys.length ?? 0) > 0}
				requireSecondFactor={securityStatus?.requireSecondFactor ?? false}
				totpEnabled={securityStatus?.totpEnabled ?? false}
				action="routing.forward"
				onOpenChange={setConfirmingForward}
				onAuthorized={(token) => save.mutate(token)}
			/>
			<StepUpDialog
				open={!!togglingRule}
				hasPassword={securityStatus?.passwordSet ?? true}
				hasPasskey={(securityStatus?.passkeys.length ?? 0) > 0}
				requireSecondFactor={securityStatus?.requireSecondFactor ?? false}
				totpEnabled={securityStatus?.totpEnabled ?? false}
				action="routing.forward"
				onOpenChange={(open) => { if (!open) setTogglingRule(null); }}
				onAuthorized={(token) => { if (togglingRule) toggle.mutate({ rule: togglingRule, stepUpToken: token }); }}
			/>
		</div>
	);
}

function RuleSection({
	className,
	title,
	description,
	rules,
	hostname,
	mailboxes,
	onEdit,
	onDelete,
	onToggle,
}: {
	className: string;
	title: string;
	description: string;
	rules: DomainRule[];
	hostname: string;
	mailboxes: { id: string; localPart: string; displayName: string | null; disabled: boolean }[];
	onEdit: (rule: DomainRule) => void;
	onDelete: (id: string) => void;
	onToggle: (rule: DomainRule) => void;
}) {
	const { t } = useLanguage();
	return (
		<Card className={`${className} border-0 bg-white px-6`}>
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle className="text-xs uppercase">{title}</CardTitle>
					<Tooltip label={description}>
						<button type="button" aria-label={description} className="text-neutral-500"><Info className="h-4 w-4" /></button>
					</Tooltip>
				</div>
			</CardHeader>
			<CardContent className="space-y-2 pb-5">
				{rules.length === 0 ? (
					<p className="text-sm text-neutral-500">{t("routing.noRules")}</p>
				) : (
					rules.map((rule) => {
						const Icon = ACTION_ICONS[rule.action];
						const ruleName = rule.name || describeRule(rule, mailboxes, hostname, t);
						return (
							<div
								key={rule.id}
								className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 px-3 py-2"
							>
								<Icon className="h-4 w-4 shrink-0 text-neutral-500" />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="truncate text-sm font-medium">
											{ruleName}
										</p>
										{!rule.enabled && <Badge variant="secondary">{t("routing.disabled")}</Badge>}
									</div>
									{rule.name && (
										<p className="truncate text-xs text-neutral-500">
											{describeRule(rule, mailboxes, hostname, t)}
										</p>
									)}
									<p className="text-xs text-neutral-500">
										{t("routing.stats", { priority: rule.priority, count: rule.matchCount, last: formatLastMatched(rule.lastMatchedAt, t) })}
									</p>
								</div>
								<Switch checked={rule.enabled} onCheckedChange={() => onToggle(rule)} aria-label={`${t("routing.enableRule")}: ${ruleName}`} />
								<Button variant="ghost" size="sm" onClick={() => onEdit(rule)} aria-label={`${t("routing.editRule")}: ${ruleName}`}>
									<Pencil className="h-4 w-4" />
								</Button>
								<Button variant="ghost" size="sm" onClick={() => onDelete(rule.id)} aria-label={`${t("rules.delete")}: ${ruleName}`}>
									<Trash2 className="h-4 w-4 text-red-600" />
								</Button>
							</div>
						);
					})
				)}
			</CardContent>
		</Card>
	);
}
