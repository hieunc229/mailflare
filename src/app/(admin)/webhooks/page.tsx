"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import type { Webhook, WebhookEvent } from "./types";
import {
	WEBHOOK_EVENTS,
	createWebhook,
	deleteWebhook,
	fetchWebhooks,
	testWebhook,
	updateWebhook,
} from "./utils";
import { WebhookDeliveries } from "./deliveries";

export default function WebhooksPage() {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [description, setDescription] = useState("");
	const [maxAttempts, setMaxAttempts] = useState(5);
	const [events, setEvents] = useState<WebhookEvent[]>(WEBHOOK_EVENTS.map((e) => e.value));
	const [secret, setSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<Record<string, string>>({});

	const webhooks = useQuery({ queryKey: ["webhooks"], queryFn: fetchWebhooks });
	const invalidate = () => qc.invalidateQueries({ queryKey: ["webhooks"] });

	const create = useMutation({
		mutationFn: () => createWebhook({ url, description: description || undefined, events, maxAttempts }),
		onSuccess: (result) => {
			setSecret(result.secret);
			setUrl("");
			setDescription("");
			setError(null);
			setDialogOpen(false);
			invalidate();
		},
		onError: (e: Error) => setError(e.message),
	});

	const toggle = useMutation({
		mutationFn: (hook: Webhook) => updateWebhook(hook.id, { enabled: !hook.enabled }),
		onSuccess: invalidate,
	});
	const rotate = useMutation({
		mutationFn: (id: string) => updateWebhook(id, { rotateSecret: true }),
		onSuccess: (result) => {
			setSecret(result.secret ?? null);
			setError(null);
		},
		onError: (cause: Error) => setError(cause.message),
	});

	const remove = useMutation({ mutationFn: deleteWebhook, onSuccess: invalidate });

	const runTest = useMutation({
		mutationFn: testWebhook,
		onSuccess: (result, id) => {
			setTestResult((prev) => ({ ...prev, [id]: result.status }));
			invalidate();
		},
		onError: (e: Error, id) => setTestResult((prev) => ({ ...prev, [id]: e.message })),
	});

	function toggleEvent(event: WebhookEvent) {
		setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold">{t("webhooks.title")}</h1>
					<p className="mt-1 text-sm text-neutral-500">
						{t("webhooks.description")}
					</p>
				</div>
				<Button
					className={mobilePrimaryActionClass}
					onClick={() => {
						setError(null);
						setDialogOpen(true);
					}}
				>
					<Plus className="h-4 w-4" /> {t("webhooks.add")}
				</Button>
			</div>

			{secret && (
				<Card>
					<CardContent className="pt-6 text-sm">
						<p className="font-medium">{t("webhooks.secretTitle")}</p>
						<p className="mt-1 text-neutral-500">
							{t("webhooks.secretHint", { header: "\u0001" }).split("\u0001").flatMap((part, index) => index === 0 ? [part] : [<code key={index}>X-Email-Platform-Signature</code>, part])}
						</p>
						<code className="mt-2 block break-all rounded-lg bg-neutral-100 p-2 text-xs">
							{secret}
						</code>
						<Button variant="outline" size="sm" className="mt-3" onClick={() => setSecret(null)}>
							{t("webhooks.dismiss")}
						</Button>
					</CardContent>
				</Card>
			)}
			{error && !dialogOpen && <p role="alert" className="text-sm text-red-600">{error}</p>}

			{webhooks.isLoading ? (
				<SectionRowSkeleton />
			) : !webhooks.data?.length ? (
				<Card>
					<CardContent className="pt-6 text-sm text-neutral-500">
						{t("webhooks.none")}
					</CardContent>
				</Card>
			) : (
				<section className="divide-y divide-neutral-100 overflow-hidden rounded-3xl bg-white">
					{webhooks.data.map((hook) => (
						<div key={hook.id} className="px-5 py-6 sm:px-6">
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0 flex-1">
									<h2 className="truncate text-base font-semibold text-neutral-900">{hook.url}</h2>
									{hook.description && (
										<p className="mt-1 text-sm text-neutral-500">{hook.description}</p>
									)}
									<div className="mt-3 flex flex-wrap gap-1.5">
										{hook.events.map((event) => (
											<Badge key={event} variant="secondary">
												{event}
											</Badge>
										))}
									</div>
								</div>
								<div className="flex items-center gap-2 rounded-full">
									<span className="text-xs font-medium text-neutral-600">{hook.enabled ? t("webhooks.enabled") : t("webhooks.disabled")}</span>
									<Switch
										checked={hook.enabled}
										onCheckedChange={() => toggle.mutate(hook)}
										aria-label={t(hook.enabled ? "webhooks.toggleLabel.disable" : "webhooks.toggleLabel.enable", { url: hook.url })}
									/>
								</div>
							</div>
							<div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl bg-neutral-50 sm:grid-cols-5">
								<div className="px-4 py-3">
									<span className="block text-lg font-semibold text-neutral-900">{hook.stats.total}</span>
									<span className="block text-xs text-neutral-500">{t("webhooks.stat.deliveries")}</span>
								</div>
								<div className="px-4 py-3">
									<span className={`block text-lg font-semibold ${hook.stats.delivered ? "text-green-600" : "text-neutral-500"}`}>
										{hook.stats.delivered}
									</span>
									<span className="block text-xs text-neutral-500">{t("webhooks.stat.delivered")}</span>
								</div>
								<div className="px-4 py-3">
									<span className={`block text-lg font-semibold ${hook.stats.pending ? "text-amber-600" : "text-neutral-500"}`}>
										{hook.stats.pending}
									</span>
									<span className="block text-xs text-neutral-500">{t("webhooks.stat.inFlight")}</span>
								</div>
								<div className="px-4 py-3">
									<span className={`block text-lg font-semibold ${hook.stats.failing ? "text-red-600" : "text-neutral-500"}`}>
										{hook.stats.failing}
									</span>
									<span className="block text-xs text-neutral-500">{t("webhooks.stat.failed")}</span>
								</div>
								<div className="px-4 py-3">
									<span className="block text-lg font-semibold text-neutral-500">{hook.maxAttempts}</span>
									<span className="block text-xs text-neutral-500">{t("webhooks.stat.maxAttempts")}</span>
								</div>
							</div>

							<div className="mt-4 flex flex-wrap items-center gap-3">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}
								>
									<Activity className="h-4 w-4" />
									{expanded === hook.id ? t("webhooks.hideHistory") : t("webhooks.history")}
								</Button>
								<div className="ml-auto flex flex-wrap items-center gap-2">
									{testResult[hook.id] && (
										<p className="mr-1 text-sm text-neutral-600">
											{t("webhooks.testDelivery", { result: testResult[hook.id] })}
										</p>
									)}
									<Button
										variant="ghost"
										size="sm"
										onClick={() => runTest.mutate(hook.id)}
										disabled={runTest.isPending}
									>
										<Send className="h-4 w-4" /> {t("webhooks.test")}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											if (window.confirm(t("webhooks.rotateConfirm"))) rotate.mutate(hook.id);
										}}
										disabled={rotate.isPending}
									>
										<RefreshCw className="h-4 w-4" /> {t("webhooks.rotate")}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => remove.mutate(hook.id)}
										aria-label={t("webhooks.deleteLabel", { url: hook.url })}
									>
										<Trash2 className="h-4 w-4" /> {t("common.delete")}
									</Button>
								</div>
							</div>

							{expanded === hook.id && (
								<div className="mt-4">
									<WebhookDeliveries webhookId={hook.id} />
								</div>
							)}
						</div>
					))}
				</section>
			)}

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{t("webhooks.add")}</DialogTitle>
						<DialogDescription>
							{t("webhooks.addDescription")}
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							create.mutate();
						}}
					>
						<div className="space-y-2">
							<Label htmlFor="hook-url">{t("webhooks.endpointUrl")}</Label>
							<Input
								id="hook-url"
								type="url"
								required
								value={url}
								onChange={(e) => setUrl(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="hook-description">{t("webhooks.descriptionLabel")}</Label>
							<Input
								id="hook-description"
								value={description}
								placeholder={t("webhooks.optional")}
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>{t("webhooks.events")}</Label>
							{WEBHOOK_EVENTS.map((event) => (
								<label
									key={event.value}
									className="flex cursor-pointer items-center justify-between rounded-lg border border-neutral-200 px-3 py-2"
								>
									<span>
										<span className="block text-sm font-medium">{t(event.labelKey)}</span>
										<span className="block text-xs text-neutral-500">{t(event.hintKey)}</span>
									</span>
									<input
										type="checkbox"
										className="h-4 w-4"
										checked={events.includes(event.value)}
										onChange={() => toggleEvent(event.value)}
									/>
								</label>
							))}
						</div>
						<div className="space-y-2">
							<Label htmlFor="hook-attempts">{t("webhooks.stat.maxAttempts")}</Label>
							<Input
								id="hook-attempts"
								type="number"
								min={1}
								max={10}
								value={maxAttempts}
								onChange={(e) => setMaxAttempts(Number(e.target.value))}
							/>
						</div>

						{error && <p role="alert" className="text-sm text-red-600">{error}</p>}

						<div className="flex justify-end gap-2">
							<Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
								{t("common.cancel")}
							</Button>
							<Button type="submit" disabled={create.isPending || events.length === 0}>
								<RefreshCw
									className={create.isPending ? "h-4 w-4 animate-spin" : "hidden"}
								/>
								{t("webhooks.create")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
