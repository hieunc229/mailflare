export type SendResult = {
	messageId?: string;
	scheduled?: boolean;
	undoSeconds?: number;
	undoRemainingMs?: number;
	scheduledAt?: string;
};

export type SendNoticePlan =
	| { kind: "undo"; messageId: string; endAt: number; durationMs: number }
	| { kind: "sending"; messageId: string }
	| { kind: "scheduled"; messageId: string; scheduledAt: string | null }
	| { kind: "sent" };

/** A scheduled-send toast carries a cancel action, so give it longer than the 3.2s default. */
export const SCHEDULED_NOTICE_MS = 8000;
/** Confirmation toasts carry a link, so leave enough time to notice and click it. */
export const SENT_NOTICE_MS = 8000;
/** How long the toast waits for the queue to report a delivered or failed message. */
export const DELIVERY_WAIT_MS = 30_000;

const SUBJECT_TOKEN = "{subject}";
const SECONDS_TOKEN = "{seconds}";

export type SendNoticeParts = {
	/** Text before the subject, including its opening punctuation. */
	before: string;
	/** Text after the subject and any countdown, including closing punctuation. */
	after: string;
	/** The linked subject label and destination. */
	link?: { label: string; href: string };
	/** Renders the ticking seconds and whatever follows them. */
	ticker?: (secondsLeft: number) => string;
};

/**
 * Splits a message template around `{subject}` so the subject can be a link, and
 * around `{seconds}` so only the ticking suffix changes while the toast is live.
 *
 * Pass the catalog entry with its placeholders intact, for example
 * `t("compose.sendingIn", { subject: "{subject}", seconds: "{seconds}" })`.
 */
export function splitSendTemplate(template: string, countdown: boolean): SendNoticeParts {
	const subjectAt = template.indexOf(SUBJECT_TOKEN);
	const before = subjectAt >= 0 ? template.slice(0, subjectAt) : template;
	const rest = subjectAt >= 0 ? template.slice(subjectAt + SUBJECT_TOKEN.length) : "";
	if (!countdown) return { before, after: rest };

	const secondsAt = rest.indexOf(SECONDS_TOKEN);
	if (secondsAt < 0) return { before, after: rest };
	return {
		before,
		after: rest.slice(0, secondsAt),
		ticker: (secondsLeft) => `${secondsLeft}${rest.slice(secondsAt + SECONDS_TOKEN.length)}`,
	};
}

/**
 * Decides which toast a send response deserves. The server reports the undo
 * window as a duration so a clock difference between server and browser cannot
 * shorten or stretch the countdown.
 */
export function resolveSendNotice(result: SendResult, now = Date.now()): SendNoticePlan {
	if (!result.messageId) return { kind: "sent" };
	if (result.undoSeconds) {
		const remaining = typeof result.undoRemainingMs === "number" && Number.isFinite(result.undoRemainingMs)
			? result.undoRemainingMs
			: result.undoSeconds * 1000;
		const durationMs = Math.max(0, remaining);
		// No time left means the queue may already be sending; watch for the result instead of guessing.
		return durationMs > 0
			? { kind: "undo", messageId: result.messageId, endAt: now + durationMs, durationMs }
			: { kind: "sending", messageId: result.messageId };
	}
	if (result.scheduled) {
		return { kind: "scheduled", messageId: result.messageId, scheduledAt: result.scheduledAt ?? null };
	}
	return { kind: "sent" };
}
