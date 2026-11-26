import { defaultTranslator, type Translator } from "../i18n/utils";

/** Choices offered in Settings; any whole number in range is accepted by the API. */
export const TRASH_RETENTION_OPTIONS = [7, 14, 30, 60, 90] as const;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;
/** Messages purged per scheduled run, so one invocation stays well inside Worker limits. */
export const TRASH_RETENTION_BATCH_SIZE = 200;

/**
 * Statuses a per-folder rule never purges, however old the message is: an unsent draft is the user's work
 * and mail the sending pipeline owns (queued, failed) may still be delivered.
 */
export const FOLDER_RETENTION_PROTECTED_STATUSES: readonly string[] = ["draft", "queued", "failed"];

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
