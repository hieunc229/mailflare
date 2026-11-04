import { withDatabase } from "./src/db/with-database";
import { withStorage } from "./src/lib/storage";
import vinextHandler from "vinext/server/fetch-handler";
import {
	processInboundMessage,
	storeRawToR2,
	type InboundQueueMessage,
} from "./src/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "./src/lib/email/send";
import { isImportJobMessage, isInboundQueueMessage, isWebhookRetryMessage } from "./worker-utils";
import { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper";
import { processImportJob, sweepImportJobs } from "./src/lib/import/jobs";
import { processWebhookRetry, type WebhookRetryMessage } from "./src/lib/email/webhooks";
import { resolveIncomingMail, forwardMessage } from "./src/lib/email/incoming";
import { getUserFromSession } from "./src/lib/auth/session";
import { getSessionTokenFromRequest } from "./src/lib/realtime/utils";
import { inboundAttachmentLimitReasonFromRaw } from "./src/lib/email/inbound-attachments";
import { hasValidSessionMutationOrigin } from "./src/lib/auth/origin";
import {
	getAccountForwardingDestination,
	isForwardedMarkerValid,
	MAILFLARE_FORWARDED_HEADER,
} from "./src/lib/email/account-forwarding";
import { runScheduledDatabaseBackup } from "./src/lib/backups/runner";
import { processAgentDraftJob } from "./src/lib/agent/jobs/utils";
import { runAgentMaintenance } from "./src/lib/agent/maintenance";
import { runTrashRetention } from "./src/lib/email/trash-retention";
import { runDriveTrashRetention } from "./src/lib/drive/retention";
import { runAccountRetention } from "./src/lib/accounts/deletion";
import { runJmapChangeRetention } from "./src/lib/jmap/changes";
import { runFollowUpReminders } from "./src/lib/follow-ups/service";
import { runCalendarReminders } from "./src/lib/calendar/reminders";
export { RealtimeHub } from "./src/lib/realtime/hub";

export default {
	async fetch(request: Request, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		const env = withDatabase(withStorage(rawEnv));
		const url = new URL(request.url);
		if (url.pathname === "/api/realtime") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}
			if (!hasValidSessionMutationOrigin(request)) {
				return new Response("Invalid origin", { status: 403 });
			}

			const user = await getUserFromSession(env, getSessionTokenFromRequest(request));
			if (!user || user.disabled) {
				return new Response("Unauthorized", { status: 401 });
			}

			const hub = env.REALTIME.getByName(user.id);
			const hubRequest = new Request("https://mailflare-realtime/connect", request);
			hubRequest.headers.set("X-Mailflare-Realtime-User", user.id);
			return hub.fetch(hubRequest);
		}

		return vinextHandler.fetch(request, env, ctx);
	},

	async email(message: ForwardableEmailMessage, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		const env = withDatabase(withStorage(rawEnv));
		try {
			if (message.rawSize > 25 * 1024 * 1024) {
				message.setReject("Message rejected: raw email exceeds the 25 MiB receiving limit. Send a download link instead.");
				return;
			}
			// Domain routing rules are resolved here rather than in the queue because reject and
			// forward can only be actioned on the live ForwardableEmailMessage.
			const alreadyForwarded = await isForwardedMarkerValid(env, message.headers.get(MAILFLARE_FORWARDED_HEADER));
			const decision = await resolveIncomingMail(env, message.from, message.to, {
				subject: message.headers.get("subject"),
				alreadyForwarded,
			});

			if (decision?.action === "reject") {
				message.setReject(decision.rejectReason ?? "Message rejected by routing rule");
				return;
			}
			const raw = await new Response(message.raw).arrayBuffer();
			const attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(raw);
			if (attachmentLimitReason) {
				message.setReject(attachmentLimitReason);
				return;
			}

			if (decision?.action === "forward" && decision.forwardTo) {
				const forwarded = await forwardMessage(env, message, decision.forwardTo);
				// A forward rule drops the message unless it was explicitly asked to keep a copy.
				// If the forward itself failed we still store it, so mail is never silently lost.
				if (forwarded && !decision.keepCopy) return;
			}

			if (!alreadyForwarded) {
				const forwardingDestination = await getAccountForwardingDestination(env, message.to);
				if (forwardingDestination) {
					await forwardMessage(env, message, forwardingDestination);
				}
			}
			const rawR2Key = await storeRawToR2(env, message.from, message.to, raw);
			const payload: InboundQueueMessage = {
				from: message.from,
				to: message.to,
				rawR2Key,
				headers: Object.fromEntries(message.headers),
			};
			await env.INBOUND_QUEUE.send(payload);
		} catch (err) {
			console.error("Inbound enqueue failed", err);
			message.setReject("Processing failed");
		}
	},

	async queue(batch: MessageBatch, rawEnv: CloudflareEnv): Promise<void> {
		const env = withDatabase(withStorage(rawEnv));
		for (const msg of batch.messages) {
			try {
				if (isInboundQueueMessage(msg.body)) {
					await processInboundMessage(env, msg.body);
				} else if (typeof msg.body === "object" && msg.body !== null && (msg.body as { kind?: unknown }).kind === "agent.draft" && typeof (msg.body as { jobId?: unknown }).jobId === "string") {
					await processAgentDraftJob(env, (msg.body as { jobId: string }).jobId);
				} else if (isWebhookRetryMessage(msg.body)) {
					await processWebhookRetry(env, msg.body as WebhookRetryMessage);
				} else if (isImportJobMessage(msg.body)) {
					await processImportJob(env, { ...msg.body, attempt: msg.attempts });
				} else if (typeof msg.body === "object" && msg.body !== null && (msg.body as { kind?: unknown }).kind === "email.scheduled") {
					await processOutboundQueue(env, msg.body as OutboundQueueMessage);
				} else {
					throw new Error("Unknown queue message type");
				}
				msg.ack();
			} catch (err) {
				console.error("Queue processing failed", {
					rawR2Key: isInboundQueueMessage(msg.body) ? msg.body.rawR2Key : undefined,
					recipient: isInboundQueueMessage(msg.body) ? msg.body.to : undefined,
					attempts: msg.attempts,
					error: err,
				});
				msg.retry({ delaySeconds: 10 });
			}
		}
	},

	async scheduled(controller: ScheduledController, rawEnv: CloudflareEnv, ctx: ExecutionContext) {
		const env = withDatabase(withStorage(rawEnv));
		if (controller.cron === "0 2 * * *") ctx.waitUntil(runScheduledDatabaseBackup(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(runAgentMaintenance(env));
		ctx.waitUntil(runTrashRetention(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(runFollowUpReminders(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(runCalendarReminders(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(sweepImportJobs(env, new Date(controller.scheduledTime)));
		if (controller.cron === "0 2 * * *") ctx.waitUntil(runAccountRetention(env, new Date(controller.scheduledTime)));
		// Drive trash is emptied once a day, with the 02:00 UTC cron; the 5-minute cron is for queue-like upkeep.
		if (controller.cron === "0 2 * * *") ctx.waitUntil(runDriveTrashRetention(env, new Date(controller.scheduledTime)));
		if (controller.cron === "0 2 * * *") ctx.waitUntil(runJmapChangeRetention(env, new Date(controller.scheduledTime)));
		if (controller.cron === "0 2 * * *") ctx.waitUntil(sweepOrphanedRawMail(env, new Date(controller.scheduledTime)).catch((error) => console.error("Raw mail sweep failed", error)));
	},
} satisfies ExportedHandler<CloudflareEnv>;
