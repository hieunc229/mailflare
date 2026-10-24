import { getAuthHeaders } from "@/lib/auth/client";
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
	for (const file of files) {
		form.append("files", file);
	}

	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", "/api/import/messages");
		getAuthHeaders().forEach((value, key) => request.setRequestHeader(key, value));
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
		};
		request.onerror = () => reject(new Error("Import upload failed"));
		request.onload = () => {
			const data = JSON.parse(request.responseText || "{}") as ImportMessagesResult;
			if (request.status < 200 || request.status >= 300) {
				reject(new Error(data.error ?? "Import failed"));
				return;
			}
			resolve(data);
		};
		request.send(form);
	});
}
