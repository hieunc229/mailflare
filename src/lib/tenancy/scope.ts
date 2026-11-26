/**
 * Wrappers that give each tenant its own slice of the shared bindings: R2 keys under `t/<id>/`, Durable
 * Object names under `<id>:` and queue messages stamped with the tenant so the consumer can rebuild its env.
 */

export const TENANT_QUEUE_FIELD = "__tenantId";

const bound = (target: object, value: unknown) => (typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value);

/** An R2 object whose `key` is shown without the tenant prefix. */
function unprefixed<T extends object>(object: T, prefix: string): T {
	return new Proxy(object, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property === "key" && typeof value === "string") return value.startsWith(prefix) ? value.slice(prefix.length) : value;
			return bound(target, value);
		},
	});
}

export function scopeBucket(bucket: R2Bucket, prefix: string): R2Bucket {
	const keyed = (key: string | string[]) => (Array.isArray(key) ? key.map((k) => prefix + k) : prefix + key);
	return {
		async get(key: string, options?: unknown) {
			const object = await (bucket.get as (k: string, o?: unknown) => Promise<object | null>)(prefix + key, options);
			return object && unprefixed(object, prefix);
		},
		async head(key: string) {
			const object = await bucket.head(prefix + key);
			return object && unprefixed(object, prefix);
		},
		put: (key: string, value: never, options?: never) => bucket.put(prefix + key, value, options),
		delete: (key: string | string[]) => bucket.delete(keyed(key) as string),
		async list(options?: R2ListOptions) {
			const result = await bucket.list({ ...options, prefix: prefix + (options?.prefix ?? ""), ...(options?.startAfter ? { startAfter: prefix + options.startAfter } : {}) });
			const strip = (key: string) => key.slice(prefix.length);
			return { ...result, objects: result.objects.map((object) => unprefixed(object, prefix)), delimitedPrefixes: (result.delimitedPrefixes ?? []).map(strip) } as R2Objects;
		},
		createMultipartUpload: (key: string, options?: R2MultipartOptions) => bucket.createMultipartUpload(prefix + key, options),
		resumeMultipartUpload: (key: string, uploadId: string) => bucket.resumeMultipartUpload(prefix + key, uploadId),
	} as unknown as R2Bucket;
}

/** Keys of mail attachments and Drive files: these are the bytes that grow, so they live in the files bucket (Backblaze B2). */
export const isFileKey = (key: string) => key.startsWith("attachments/") || key.startsWith("drive/");

/**
 * One bucket in front of two: files (`isFile`) go to `files`, everything else (raw mail, avatars, branding, secrets)
 * stays in `primary`. Callers keep using the R2 API and never learn there are two stores.
 */
export function routeBucket(primary: R2Bucket, files: R2Bucket, isFile: (key: string) => boolean = isFileKey): R2Bucket {
	const pick = (key: string) => (isFile(key) ? files : primary);
	return {
		get: (key: string, options?: never) => (pick(key).get as (k: string, o?: unknown) => Promise<unknown>)(key, options),
		head: (key: string) => pick(key).head(key),
		put: (key: string, value: never, options?: never) => pick(key).put(key, value, options),
		async delete(keys: string | string[]) {
			const list = Array.isArray(keys) ? keys : [keys];
			const inFiles = list.filter(isFile);
			const inPrimary = list.filter((key) => !isFile(key));
			await Promise.all([inFiles.length ? files.delete(inFiles) : undefined, inPrimary.length ? primary.delete(inPrimary) : undefined]);
		},
		list: (options?: R2ListOptions) => (options?.prefix && isFile(options.prefix) ? files : primary).list(options),
		createMultipartUpload: (key: string, options?: R2MultipartOptions) => pick(key).createMultipartUpload(key, options),
		resumeMultipartUpload: (key: string, uploadId: string) => pick(key).resumeMultipartUpload(key, uploadId),
	} as unknown as R2Bucket;
}

export function scopeQueue<T extends Queue>(queue: T, tenantId: string): T {
	const stamp = (body: unknown) => (body && typeof body === "object" ? { ...(body as object), [TENANT_QUEUE_FIELD]: tenantId } : body);
	return {
		send: (body: unknown, options?: QueueSendOptions) => queue.send(stamp(body), options),
		sendBatch: (messages: Iterable<MessageSendRequest>, options?: QueueSendBatchOptions) =>
			queue.sendBatch([...messages].map((message) => ({ ...message, body: stamp(message.body) })), options),
	} as unknown as T;
}

export function scopeNamespace<T extends object>(namespace: T, tenantId: string): T {
	const named = (name: string) => `${tenantId}:${name}`;
	const ns = namespace as unknown as { getByName(n: string, o?: unknown): unknown; idFromName(n: string): unknown };
	return new Proxy(namespace, {
		get(target, property) {
			if (property === "getByName") return (name: string, options?: unknown) => ns.getByName(named(name), options);
			if (property === "idFromName") return (name: string) => ns.idFromName(named(name));
			return bound(target, Reflect.get(target, property));
		},
	});
}
