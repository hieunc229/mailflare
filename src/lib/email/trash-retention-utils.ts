import { defaultTranslator, type Translator } from "../i18n/utils";

/** Choices offered in Settings; any whole number in range is accepted by the API. */
export const TRASH_RETENTION_OPTIONS = [7, 14, 30, 60, 90] as const;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;
/** Messages purged per scheduled run, so one invocation stays well inside Worker limits. */
export const TRASH_RETENTION_BATCH_SIZE = 200;

/**
 * Message statuses a per-folder rule may delete. Positive list on purpose: `messages.status` is free text, so
 * an unknown value must mean "keep". `received` and `archived` are the two normal filing statuses; `draft`,
 * `queued` and `failed` are unsent or still sending, `sent` is the user's sent record (JMAP files sent mail
 * into folders as literal `sent`), and Trash/Spam belong to the owner's Trash retention rule.
 *
 * Status alone cannot see provenance: the web send path completes a scheduled message and the bulk folder
 * action rewrites it to `received`, so the folder rule also requires `messages.direction <> 'outbound'` —
 * that column is written by every send path and by imported Sent/Drafts mail, and filing never rewrites it.
 */
export const FOLDER_RETENTION_ELIGIBLE_STATUSES: readonly string[] = ["received", "archived"];

/**
 * `outbound_jobs.status` values that mean the send is still in flight; `sent` and `failed` are terminal. A
 * message a live job owns is never purged: the FK is ON DELETE SET NULL, so deleting the row would leave the
 * job sending with nothing to send.
 */
export const NON_TERMINAL_OUTBOUND_JOB_STATUSES = ["queued", "sending"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Messages that entered Trash or Spam before this instant are due for deletion. */
export function getTrashRetentionCutoff(now: Date, days: number): Date {
	return new Date(now.getTime() - days * DAY_MS);
}

/** Null (or anything outside the supported range) means "never delete automatically". */
export function normalizeTrashRetentionDays(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	if (value < MIN_TRASH_RETENTION_DAYS || value > MAX_TRASH_RETENTION_DAYS) return null;
	return value;
}

export function describeTrashRetention(days: number | null, t: Translator = defaultTranslator): string {
	if (!days) return t("settings.trash.never");
	return t("settings.trash.afterDay", { count: days });
}
