/** A runtime body as a Buffer over exactly its own bytes (a view's offset and length are honoured). */
export function toBytes(value: ArrayBuffer | ArrayBufferView | string): Buffer {
	if (typeof value === "string") return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
