import type { MessageActionStatus } from "./types";

export function getMessageBackHref(direction: "inbound" | "outbound", status: string) {
	if (status === "trash") return "/trash";
	if (status === "spam") return "/spam";
	if (status === "draft") return "/drafts";
	return direction === "inbound" ? "/inbox" : "/sent";
}

export async function updateMessageFolder(messageId: string, status: MessageActionStatus) {
	const response = await fetch(`/api/messages/${messageId}/status`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status }),
	});

	if (!response.ok) {
		throw new Error("Unable to update message");
	}

	window.dispatchEvent(new Event("mailflare:messages-changed"));
}
