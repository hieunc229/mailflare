/** Minimal in-memory R2 bucket (put/get/delete) for tests; `puts` records every write in order. */
export function memoryBucket({ failPut = false, onPut } = {}) {
	const objects = new Map();
	const puts = [];
	const multipart = [];
	return {
		objects,
		puts,
		multipart,
		async put(key, body, options) {
			if (failPut) throw new Error("R2 unavailable");
			onPut?.(key);
			const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
			objects.set(key, { bytes, options });
			puts.push(key);
			return { size: bytes.length };
		},
		async createMultipartUpload(key, options) {
			const parts = [];
			multipart.push(key);
			if (failPut) throw new Error("R2 unavailable");
			return {
				async uploadPart(partNumber, body) { parts.push(new Uint8Array(body)); return { partNumber, etag: `e${partNumber}` }; },
				async abort() {},
				async complete() {
					const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
					let offset = 0;
					for (const part of parts) { bytes.set(part, offset); offset += part.length; }
					objects.set(key, { bytes, options });
					return { size: bytes.length };
				},
			};
		},
		async get(key) {
			const object = objects.get(key);
			return object ? { arrayBuffer: async () => object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength) } : null;
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}
