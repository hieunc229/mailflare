import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { importJobs, mailboxes } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getImportMessageUserId, parseImportDestination } from "./destination";
import { fetchImapMessages } from "./imap";
import { getImapChunkSize, growImapChunkSize, isMissingImapFolderError, isPermanentImapError } from "./imap-utils";
import { deleteStagedImport, importBatchKey, stageImportMessages, unpackImportMessages } from "./staging";
import { importMessagesToMailbox } from "./service";
import type {
	FileImportCursor,
	FileImportSpec,
	ImapImportCursor,
	ImapImportSource,
	ImapImportSpec,
	ImportJobMessage,
	ImportJobSummary,
} from "./jobs-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

const ACTIVE = ["queued", "running"] as const;
const MAX_STORED_ERRORS = 20;
/** IMAP messages fetched per queue message; the connection is reopened for each. */
const IMAP_CHUNK_SIZE = 50;
/** Consecutive failed IMAP chunks, each retried smaller, before the job gives up. */
const MAX_IMAP_FAILURES = 4;
const STALE_AFTER_MS = 30 * 60 * 1000;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

type JobRow = typeof importJobs.$inferSelect;

type Chunk = {
	result: ImportMailboxResult;
	cursor: FileImportCursor | ImapImportCursor;
	totalDelta: number;
	done: boolean;
	/** Staged object that is safe to delete once the chunk is recorded. */
	consumedKey?: string;
};

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

async function enqueue(env: CloudflareEnv, message: ImportJobMessage): Promise<void> {
	await env.OUTBOUND_QUEUE.send(message);
}

export function toImportJobSummary(row: JobRow): ImportJobSummary {
	let currentSource: string | null = null;
	if (row.kind === "imap" && row.status === "running") {
		const spec = parseJson<ImapImportSpec | null>(row.spec, null);
		const cursor = parseJson<ImapImportCursor>(row.cursor, { source: 0, done: 0, counted: false });
		currentSource = spec?.sources[cursor.source]?.folder ?? null;
	}
	return {
		id: row.id,
		mailboxId: row.mailboxId,
		kind: row.kind,
		label: row.label,
		status: row.status,
		total: row.total,
		processed: row.processed,
		imported: row.imported,
		skipped: row.skipped,
		errors: parseJson<string[]>(row.errors, []),
		errorCount: row.errorCount,
		error: row.error,
		currentSource,
		createdAt: row.createdAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

export async function listImportJobs(env: CloudflareEnv, userId: string, limit = 20): Promise<ImportJobSummary[]> {
	const rows = await getDb(env)
		.select()
		.from(importJobs)
		.where(eq(importJobs.userId, userId))
		.orderBy(desc(importJobs.createdAt))
		.limit(limit);
	return rows.map(toImportJobSummary);
}

export async function createFileImportJob(
	env: CloudflareEnv,
	input: { userId: string; mailboxId: string; label: string; destination: string; messages: ImportMessageInput[] },
): Promise<ImportJobSummary> {
	const db = getDb(env);
	const id = newId("imp");
	const batches = await stageImportMessages(env, id, input.messages);
	const spec: FileImportSpec = { destination: input.destination, batches };
	const cursor: FileImportCursor = { batch: 0 };
	try {
		const [row] = await db
			.insert(importJobs)
			.values({
				id,
				userId: input.userId,
				mailboxId: input.mailboxId,
				kind: "file",
				label: input.label,
				total: input.messages.length,
				spec: JSON.stringify(spec),
				cursor: JSON.stringify(cursor),
			})
			.returning();
		await enqueue(env, { kind: "import.run", jobId: id });
		return toImportJobSummary(row);
	} catch (error) {
		await deleteStagedImport(env, id, batches);
		await db.delete(importJobs).where(eq(importJobs.id, id));
		throw error;
	}
}

export async function createImapImportJob(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		password: string;
		spec: ImapImportSpec;
	},
): Promise<ImportJobSummary> {
	const db = getDb(env);
	const id = newId("imp");
	const cursor: ImapImportCursor = { source: 0, done: 0, counted: false };
	try {
		const [row] = await db
			.insert(importJobs)
			.values({
				id,
				userId: input.userId,
				mailboxId: input.mailboxId,
				kind: "imap",
				label: `${input.spec.username} @ ${input.spec.host}`,
				spec: JSON.stringify(input.spec),
				cursor: JSON.stringify(cursor),
			})
			.returning();
		await enqueue(env, { kind: "import.run", jobId: id, imapPassword: input.password });
		return toImportJobSummary(row);
	} catch (error) {
		await db.delete(importJobs).where(eq(importJobs.id, id));
		throw error;
	}
}

async function cleanupJob(env: CloudflareEnv, row: JobRow): Promise<void> {
	if (row.kind !== "file") return;
	const spec = parseJson<FileImportSpec>(row.spec, { destination: "", batches: 0 });
	await deleteStagedImport(env, row.id, spec.batches);
}

/** Cancels a running job, or removes the record of a finished one. Returns false when it is not the user's. */
export async function cancelOrDismissImportJob(env: CloudflareEnv, userId: string, jobId: string): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(importJobs)
		.where(and(eq(importJobs.id, jobId), eq(importJobs.userId, userId)))
		.limit(1);
	if (!row) return false;
	if (row.status === "queued" || row.status === "running") {
		const now = new Date();
		await db
			.update(importJobs)
			.set({ status: "cancelled", finishedAt: now, updatedAt: now })
			.where(and(eq(importJobs.id, jobId), inArray(importJobs.status, [...ACTIVE])));
		await cleanupJob(env, row);
	} else {
		await db.delete(importJobs).where(eq(importJobs.id, jobId));
		await cleanupJob(env, row);
	}
	return true;
}

export type ResumeImportResult =
	| { ok: true; job: ImportJobSummary }
	| { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Continues a failed job from its saved cursor. IMAP passwords are never stored, so the caller supplies
 * it again; file jobs continue from their staged batches when those still exist.
 */
export async function resumeImportJob(
	env: CloudflareEnv,
	userId: string,
	jobId: string,
	password?: string,
): Promise<ResumeImportResult> {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(importJobs)
		.where(and(eq(importJobs.id, jobId), eq(importJobs.userId, userId)))
		.limit(1);
	if (!row) return { ok: false, status: 404, error: "Import not found" };
	if (row.status !== "failed") return { ok: false, status: 409, error: "Only a failed import can be resumed" };

	let cursor = row.cursor;
	if (row.kind === "imap") {
		if (!password) return { ok: false, status: 400, error: "Enter the IMAP password to resume" };
		const parsed = parseJson<ImapImportCursor>(row.cursor, { source: 0, done: 0, counted: false });
		cursor = JSON.stringify({ ...parsed, failures: undefined });
	} else {
		const parsed = parseJson<FileImportCursor>(row.cursor, { batch: 0 });
		if (!(await env.BUCKET.head(importBatchKey(row.id, parsed.batch)))) {
			return { ok: false, status: 409, error: "Uploaded files are no longer available; upload them again" };
		}
	}

	const now = new Date();
	const [claimed] = await db
		.update(importJobs)
		.set({ status: "queued", error: null, finishedAt: null, cursor, updatedAt: now })
		.where(and(eq(importJobs.id, row.id), eq(importJobs.status, "failed")))
		.returning();
	if (!claimed) return { ok: false, status: 409, error: "Only a failed import can be resumed" };
	await enqueue(env, { kind: "import.run", jobId: row.id, ...(row.kind === "imap" ? { imapPassword: password } : {}) });
	return { ok: true, job: toImportJobSummary(claimed) };
}

/** Runs one chunk of a job and queues the next. Never throws for import failures; they land on the job. */
export async function processImportJob(env: CloudflareEnv, delivered: ImportJobMessage): Promise<void> {
	const { attempt, ...message } = delivered;
	const db = getDb(env);
	const [job] = await db.select().from(importJobs).where(eq(importJobs.id, message.jobId)).limit(1);
	if (!job || (job.status !== "queued" && job.status !== "running")) return;

	if (job.status === "queued") {
		await db
			.update(importJobs)
			.set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "queued")));
	}

	let chunk: Chunk;
	try {
		chunk = job.kind === "file" ? await runFileChunk(env, job) : await runImapChunk(env, job, message.imapPassword, attempt);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Import failed";
		if (job.kind === "imap" && (await retryImapChunkSmaller(env, job, message, reason))) return;
		const now = new Date();
		await db
			.update(importJobs)
			.set({
				status: "failed",
				error: reason,
				finishedAt: now,
				updatedAt: now,
			})
			.where(and(eq(importJobs.id, job.id), inArray(importJobs.status, [...ACTIVE])));
		// Staged uploads stay so the job can be resumed; dismissing or pruning it deletes them.
		return;
	}

	const now = new Date();
	const errors = [...parseJson<string[]>(job.errors, []), ...chunk.result.errors].slice(0, MAX_STORED_ERRORS);
	const recorded = await db
		.update(importJobs)
		.set({
			total: job.total + chunk.totalDelta,
			processed: job.processed + chunk.result.imported + chunk.result.skipped,
			imported: job.imported + chunk.result.imported,
			skipped: job.skipped + chunk.result.skipped,
			errors: JSON.stringify(errors),
			errorCount: job.errorCount + chunk.result.errors.length,
			cursor: JSON.stringify(chunk.cursor),
			updatedAt: now,
			...(chunk.done ? { status: "completed" as const, finishedAt: now } : {}),
		})
		.where(and(eq(importJobs.id, job.id), inArray(importJobs.status, [...ACTIVE])))
		.returning({ id: importJobs.id });

	// Cancelled while the chunk ran: the cancel already cleaned up.
	if (!recorded.length) return;
	if (chunk.consumedKey) await env.BUCKET.delete(chunk.consumedKey).catch(() => undefined);
	if (!chunk.done) await enqueue(env, message);
}

/** Records the failure, halves the chunk size and queues the same chunk again. False when the job should fail instead. */
async function retryImapChunkSmaller(
	env: CloudflareEnv,
	job: JobRow,
	message: ImportJobMessage,
	reason: string,
): Promise<boolean> {
	if (isPermanentImapError(reason)) return false;
	const cursor = parseJson<ImapImportCursor>(job.cursor, { source: 0, done: 0, counted: false });
	const failures = (cursor.failures ?? 0) + 1;
	if (failures >= MAX_IMAP_FAILURES) return false;
	const spec = parseJson<ImapImportSpec | null>(job.spec, null);
	const base = spec ? imapBaseChunkSize(spec, cursor) : IMAP_CHUNK_SIZE;
	const next: ImapImportCursor = { ...cursor, failures, size: Math.max(1, Math.floor(getImapChunkSize(base, cursor.size) / 2)) };
	const recorded = await getDb(env)
		.update(importJobs)
		.set({ cursor: JSON.stringify(next), updatedAt: new Date() })
		.where(and(eq(importJobs.id, job.id), inArray(importJobs.status, [...ACTIVE])))
		.returning({ id: importJobs.id });
	if (recorded.length) await enqueue(env, message);
	return true;
}

function imapBaseChunkSize(spec: ImapImportSpec, cursor: ImapImportCursor): number {
	return Math.min(IMAP_CHUNK_SIZE, spec.importAll ? spec.limit : spec.limit - cursor.done);
}

async function getImportUserId(env: CloudflareEnv, job: JobRow, destinationValue: string): Promise<string> {
	const [mailbox] = await getDb(env)
		.select({ userId: mailboxes.userId })
		.from(mailboxes)
		.where(eq(mailboxes.id, job.mailboxId))
		.limit(1);
	if (!mailbox) throw new Error("Mailbox no longer exists");
	return getImportMessageUserId(parseImportDestination(destinationValue), job.userId, mailbox.userId);
}

async function runFileChunk(env: CloudflareEnv, job: JobRow): Promise<Chunk> {
	const spec = parseJson<FileImportSpec>(job.spec, { destination: "", batches: 0 });
	const cursor = parseJson<FileImportCursor>(job.cursor, { batch: 0 });
	const key = importBatchKey(job.id, cursor.batch);
	const object = await env.BUCKET.get(key);
	if (!object) throw new Error("Uploaded files are no longer available; upload them again");
	const messages = unpackImportMessages(new Uint8Array(await object.arrayBuffer()));
	const result = await importMessagesToMailbox(env, {
		userId: await getImportUserId(env, job, spec.destination),
		mailboxId: job.mailboxId,
		destination: parseImportDestination(spec.destination),
		messages,
	});
	const next = cursor.batch + 1;
	return { result, cursor: { batch: next }, totalDelta: 0, done: next >= spec.batches, consumedKey: key };
}

async function runImapChunk(
	env: CloudflareEnv,
	job: JobRow,
	password: string | undefined,
	attempt?: number,
): Promise<Chunk> {
	if (!password) throw new Error("IMAP credentials were lost; start the import again");
	const spec = parseJson<ImapImportSpec | null>(job.spec, null);
	if (!spec) throw new Error("Import settings are unreadable");
	const cursor = parseJson<ImapImportCursor>(job.cursor, { source: 0, done: 0, counted: false });
	const source: ImapImportSource | undefined = spec.sources[cursor.source];
	const empty: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	if (!source) return { result: empty, cursor, totalDelta: 0, done: true };

	const base = imapBaseChunkSize(spec, cursor);
	const batchSize = base > 0 ? getImapChunkSize(base, cursor.size, attempt) : 0;
	let fetched: Awaited<ReturnType<typeof fetchImapMessages>> = { messages: [], total: 0, nextOffset: null };
	if (batchSize > 0) {
		try {
			fetched = await fetchImapMessages({
				host: spec.host,
				port: spec.port,
				secure: spec.secure,
				username: spec.username,
				password,
				folder: source.folder,
				limit: batchSize,
				offset: cursor.done,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : "";
			if (!isMissingImapFolderError(reason)) throw error;
			// A folder that cannot be opened (Gmail's `[Gmail]` parent) must not sink the whole import.
			const nextSource = cursor.source + 1;
			return {
				result: { imported: 0, skipped: 0, errors: [`${source.folder}: ${reason}`] },
				cursor: { source: nextSource, done: 0, counted: false },
				totalDelta: 0,
				done: nextSource >= spec.sources.length,
			};
		}
	}

	const result = fetched.messages.length
		? await importMessagesToMailbox(env, {
				userId: await getImportUserId(env, job, source.destination),
				mailboxId: job.mailboxId,
				destination: parseImportDestination(source.destination),
				messages: fetched.messages,
			})
		: empty;

	const done = cursor.done + fetched.messages.length;
	const grown = batchSize > 0 ? growImapChunkSize(IMAP_CHUNK_SIZE, batchSize) : undefined;
	const totalDelta = cursor.counted ? 0 : spec.importAll ? fetched.total : Math.min(spec.limit, fetched.total);
	const sourceFinished = fetched.nextOffset === null || fetched.messages.length === 0 || (!spec.importAll && done >= spec.limit);
	if (!sourceFinished) {
		return { result, cursor: { source: cursor.source, done, counted: true, size: grown }, totalDelta, done: false };
	}
	const nextSource = cursor.source + 1;
	return {
		result,
		cursor: { source: nextSource, done: 0, counted: false, size: grown },
		totalDelta,
		done: nextSource >= spec.sources.length,
	};
}

/** Fails jobs whose queue messages were lost, and drops old finished records. Safe to run on every cron tick. */
export async function sweepImportJobs(env: CloudflareEnv, now = new Date()): Promise<void> {
	const db = getDb(env);
	const stale = await db
		.select()
		.from(importJobs)
		.where(and(inArray(importJobs.status, [...ACTIVE]), lt(importJobs.updatedAt, new Date(now.getTime() - STALE_AFTER_MS))));
	for (const row of stale) {
		await db
			.update(importJobs)
			.set({ status: "failed", error: "Import was interrupted", finishedAt: now, updatedAt: now })
			.where(and(eq(importJobs.id, row.id), inArray(importJobs.status, [...ACTIVE])));
	}
	const expired = and(
		inArray(importJobs.status, ["completed", "failed", "cancelled"]),
		lt(importJobs.finishedAt, new Date(now.getTime() - KEEP_FINISHED_MS)),
	);
	const old = await db.select().from(importJobs).where(expired);
	for (const row of old) await cleanupJob(env, row);
	await db.delete(importJobs).where(expired);
}
