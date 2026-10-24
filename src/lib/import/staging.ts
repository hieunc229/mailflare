import type { ImportMessageInput } from "./types";

/** Messages per staged object, and per queue message that consumes one. */
export const IMPORT_BATCH_SIZE = 25;

export function importBatchKey(jobId: string, batch: number): string {
	return `import-jobs/${jobId}/${batch}.bin`;
}

/**
 * A staged batch is `[u32 header length][JSON header][raw message bytes...]`, so a
 * whole upload costs one bucket write per batch instead of one per message.
 */
export function packImportMessages(items: ImportMessageInput[]): Uint8Array {
	const header = new TextEncoder().encode(
		JSON.stringify(items.map((item) => ({ filename: item.filename, size: item.raw.byteLength }))),
	);
	const bodySize = items.reduce((sum, item) => sum + item.raw.byteLength, 0);
	const out = new Uint8Array(4 + header.byteLength + bodySize);
	new DataView(out.buffer).setUint32(0, header.byteLength);
	out.set(header, 4);
	let offset = 4 + header.byteLength;
	for (const item of items) {
		out.set(new Uint8Array(item.raw), offset);
		offset += item.raw.byteLength;
	}
	return out;
}

export function unpackImportMessages(bytes: Uint8Array): ImportMessageInput[] {
	const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as {
		filename: string;
		size: number;
	}[];
	let offset = 4 + headerLength;
	return header.map(({ filename, size }) => {
		const raw = bytes.slice(offset, offset + size).buffer as ArrayBuffer;
		offset += size;
		return { filename, raw };
	});
}

/** Stages messages in batches and returns how many objects were written. */
export async function stageImportMessages(
	env: CloudflareEnv,
	jobId: string,
	messages: ImportMessageInput[],
): Promise<number> {
	let batches = 0;
	try {
		for (let start = 0; start < messages.length; start += IMPORT_BATCH_SIZE) {
			await env.BUCKET.put(
				importBatchKey(jobId, batches),
				packImportMessages(messages.slice(start, start + IMPORT_BATCH_SIZE)),
			);
			batches += 1;
		}
	} catch (error) {
		await deleteStagedImport(env, jobId, batches);
		throw error;
	}
	return batches;
}

export async function deleteStagedImport(env: CloudflareEnv, jobId: string, batches: number): Promise<void> {
	for (let batch = 0; batch < batches; batch += 1) {
		await env.BUCKET.delete(importBatchKey(jobId, batch)).catch(() => undefined);
	}
}
