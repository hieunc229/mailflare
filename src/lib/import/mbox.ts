const FROM_LINE = /^From /;

function trimTrailingLineBreaks(value: string): string {
	return value.replace(/\r?\n$/, "");
}

function unescapeMboxBody(value: string): string {
	// mboxrd: drop one ">" from every quoted ">*From " line, matching the export.
	return value.replace(/\n>(>*From )/g, "\n$1");
}

export function splitMboxMessages(content: string): string[] {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const messages: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		if (FROM_LINE.test(line)) {
			if (current.length > 0) {
				messages.push(unescapeMboxBody(trimTrailingLineBreaks(current.join("\n"))));
				current = [];
			}
			continue;
		}
		current.push(line);
	}

	if (current.length > 0) {
		messages.push(unescapeMboxBody(trimTrailingLineBreaks(current.join("\n"))));
	}

	return messages.filter((message) => message.trim().length > 0);
}

/**
 * Split an mbox given as raw bytes. Separators and quoting are ASCII, so the bytes are split as a
 * Latin-1 string (one char per byte, lossless) and turned back into the same bytes, which keeps 8-bit bodies intact.
 */
export function splitMboxBytes(buffer: ArrayBuffer): ArrayBuffer[] {
	const bytes = new Uint8Array(buffer);
	let content = "";
	for (let index = 0; index < bytes.length; index += 0x2000) {
		content += String.fromCharCode(...bytes.subarray(index, index + 0x2000));
	}
	return splitMboxMessages(content).map((message) => {
		const out = new Uint8Array(message.length);
		for (let index = 0; index < message.length; index += 1) out[index] = message.charCodeAt(index);
		return out.buffer as ArrayBuffer;
	});
}
