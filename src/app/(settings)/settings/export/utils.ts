import { authFetch } from "@/lib/auth/client";

/** Probes the export for an error, then lets the browser stream the download (the route names the file). */
export async function exportMailbox(mailboxId: string): Promise<void> {
	const url = `/api/export/messages?${new URLSearchParams({ mailboxId }).toString()}`;
	try {
		const response = await authFetch(url, { method: "HEAD" });
		if (!response.ok) throw new Error(response.status === 404 ? "Mailbox not found" : "Export failed");
	} catch (error) {
		if (error instanceof Error && (error.message === "Mailbox not found" || error.message === "Export failed")) throw error;
	}
	window.location.assign(url);
}
