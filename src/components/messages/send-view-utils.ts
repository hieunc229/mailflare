/** Only move the reader for the message whose delivery state changed. */
export function resolveSendViewRoute(pathname: string, messageId: string, status: string): string | null {
	if (pathname !== `/scheduled/${messageId}` && pathname !== `/sent/${messageId}`) return null;
	if (status === "draft") return pathname.startsWith("/scheduled/") ? "/scheduled" : "/sent";
	if (status === "sent" && pathname === `/scheduled/${messageId}`) return `/sent/${messageId}`;
	return null;
}
