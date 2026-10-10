"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WebhookDelivery } from "./types";
import {
	DELIVERY_STATUS_LABELS,
	fetchDeliveries,
	formatDuration,
	formatTimestamp,
	isRetryable,
	retryDelivery,
} from "./utils";

const STATUS_STYLES: Record<WebhookDelivery["status"], string> = {
	delivered: "bg-green-600/10 text-green-700",
	failed: "bg-red-600/10 text-red-700",
	exhausted: "bg-red-600/10 text-red-700",
	retrying: "bg-amber-500/10 text-amber-700",
	pending: "bg-neutral-200 text-neutral-700",
};

export function WebhookDeliveries({ webhookId }: { webhookId: string }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const deliveries = useQuery({
		queryKey: ["webhook-deliveries", webhookId],
		queryFn: () => fetchDeliveries(webhookId),
		// Retries land asynchronously from the queue, so keep the table fresh while it is open.
		refetchInterval: 15_000,
	});

	const retry = useMutation({
		mutationFn: (deliveryId: string) => retryDelivery(webhookId, deliveryId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["webhook-deliveries", webhookId] });
			qc.invalidateQueries({ queryKey: ["webhooks"] });
		},
	});

	if (deliveries.isLoading) {
		return <p className="text-sm text-neutral-500">{t("webhooks.loadingDeliveries")}</p>;
	}

	if (!deliveries.data?.length) {
		return <p className="text-sm text-neutral-500">{t("webhooks.noDeliveries")}</p>;
	}

	return (
		<div className="overflow-x-auto rounded-xl border border-neutral-200">
			<table className="w-full min-w-[820px] text-left text-sm">
				<thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
					<tr>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.event")}</th>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.status")}</th>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.attempts")}</th>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.response")}</th>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.lastAttempt")}</th>
						<th className="px-3 py-2 font-medium">{t("webhooks.col.nextRetry")}</th>
						<th className="px-3 py-2 font-medium" />
					</tr>
				</thead>
				<tbody>
					{deliveries.data.map((delivery) => (
						<tr key={delivery.id} className="border-t border-neutral-100 align-top">
							<td className="px-3 py-2">
								<span className="block">{delivery.eventType}</span>
								<span className="block text-xs text-neutral-500">
									{formatTimestamp(delivery.createdAt)}
								</span>
							</td>
							<td className="px-3 py-2">
								<Badge className={STATUS_STYLES[delivery.status]}>
									{DELIVERY_STATUS_LABELS[delivery.status] ? t(DELIVERY_STATUS_LABELS[delivery.status]) : delivery.status}
								</Badge>
							</td>
							<td className="px-3 py-2 whitespace-nowrap">
								{/* Manual retries can push attempts past the configured max, so never show "3 / 2". */}
								{delivery.attempts} / {Math.max(delivery.maxAttempts, delivery.attempts)}
							</td>
							<td className="px-3 py-2">
								<span className="block whitespace-nowrap">
									{delivery.responseStatus ?? "—"}
									{delivery.durationMs !== null && (
										// An explicit separator: "200" next to "6ms" otherwise reads as "2006ms".
										<span className="ml-1 text-xs text-neutral-500">
											· {formatDuration(delivery.durationMs)}
										</span>
									)}
								</span>
								{delivery.error && (
									<span className="mt-1 block max-w-xs truncate text-xs text-red-600" title={delivery.error}>
										{delivery.error}
									</span>
								)}
							</td>
							<td className="px-3 py-2 whitespace-nowrap text-neutral-600">
								{formatTimestamp(delivery.lastAttemptAt)}
							</td>
							<td className="px-3 py-2 whitespace-nowrap text-neutral-600">
								{formatTimestamp(delivery.nextRetryAt)}
							</td>
							<td className="px-3 py-2">
								{isRetryable(delivery) && (
									<Button
										variant="outline"
										size="sm"
										disabled={retry.isPending}
										onClick={() => retry.mutate(delivery.id)}
									>
										<RotateCw className="h-3 w-3" /> {t("webhooks.retry")}
									</Button>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
