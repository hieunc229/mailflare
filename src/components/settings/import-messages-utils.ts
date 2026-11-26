import { getAuthHeaders } from "@/lib/auth/client";
import { prepareUpload } from "@/lib/uploads/client";
import type { ImportMessagesResult, ImportProgressHandler } from "./import-messages-types";

export async function importMessageFiles(
	mailboxId: string,
	files: File[],
	destination: string,
	onProgress?: ImportProgressHandler,
): Promise<ImportMessagesResult> {
	const form = new FormData();
	form.set("mailboxId", mailboxId);
	form.set("destination", destination);
	form.set("background", "1");
	for (const file of files) {
		form.append("files", file);
	}

	// Where the body goes through storage first (Vercel), that transfer is what the progress bar follows.
	const upload = await prepareUpload(form, {
		onProgress: (loaded, total) => onProgress?.(Math.round((loaded / total) * 100)),
	});

	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", "/api/import/messages");
		getAuthHeaders(upload.headers).forEach((value, key) => request.setRequestHeader(key, value));
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
		};
		request.onerror = () => reject(new Error("Import upload failed"));
		request.onabort = () => reject(new Error("Import upload cancelled"));
		request.ontimeout = () => reject(new Error("Import upload timed out"));
		request.onload = () => {
			// A proxy can answer with an HTML error page; fall through to the status check.
			const data = parseImportResponse(request.responseText);
			if (request.status < 200 || request.status >= 300) {
				reject(new Error(data.error ?? "Import failed"));
				return;
			}
			resolve(data);
		};
		request.send(upload.body ?? null);
	});
}

function parseImportResponse(text: string): ImportMessagesResult {
	try {
		const data: unknown = JSON.parse(text || "{}");
		return data && typeof data === "object" ? (data as ImportMessagesResult) : {};
	} catch {
		return {};
	}
}
