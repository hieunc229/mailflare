export const APPLE_PROFILE_FILE_NAME = "mailflare-calendar-contacts.mobileconfig";

export type AppleProfileInput = {
	/** `https://host` or `https://host:port`; iOS and macOS only take these accounts over TLS. */
	origin: string;
	userId: string;
	username: string;
	password: string;
	/** Whether the account has the calendar switched on; without it only the contacts account is added. */
	calendar?: boolean;
	/** A fresh UUID per call; injected so the output is testable. */
	uuid: () => string;
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * A configuration profile that adds the CalDAV and CardDAV accounts on iOS and
 * macOS in one step. It contains the app password, so it is built in the
 * browser from the one-time reveal and handed to the user as a download; it is
 * never sent to the server.
 */
export function buildAppleProfile({ origin, userId, username, password, calendar = true, uuid }: AppleProfileInput): string {
	const url = new URL(origin);
	if (url.protocol !== "https:") throw new Error("An Apple profile needs an https address");
	const port = url.port || "443";
	// Absolute, so the profile names the server it came from. The host also keeps profiles for two servers apart.
	const principal = `${url.origin}/dav/principals/${encodeURIComponent(userId)}/`;
	const host = escapeXml(url.hostname);
	const account = (prefix: "CalDAV" | "CardDAV", type: string, title: string) => [
		"\t\t<dict>",
		...[
			["PayloadType", `<string>${type}</string>`],
			["PayloadVersion", "<integer>1</integer>"],
			["PayloadIdentifier", `<string>com.mailflare.dav.${prefix.toLowerCase()}.${host}.${escapeXml(userId)}</string>`],
			["PayloadUUID", `<string>${uuid()}</string>`],
			["PayloadDisplayName", `<string>${title}</string>`],
			[`${prefix}AccountDescription`, `<string>${title}</string>`],
			[`${prefix}HostName`, `<string>${host}</string>`],
			[`${prefix}Port`, `<integer>${escapeXml(port)}</integer>`],
			[`${prefix}UseSSL`, "<true/>"],
			[`${prefix}Username`, `<string>${escapeXml(username)}</string>`],
			[`${prefix}Password`, `<string>${escapeXml(password)}</string>`],
			[`${prefix}PrincipalURL`, `<string>${escapeXml(principal)}</string>`],
		].map(([key, value]) => `\t\t\t<key>${key}</key>\n\t\t\t${value}`),
		"\t\t</dict>",
	].join("\n");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>PayloadContent</key>",
		"\t<array>",
		...(calendar ? [account("CalDAV", "com.apple.caldav.account", "Mailflare Calendar")] : []),
		account("CardDAV", "com.apple.carddav.account", "Mailflare Contacts"),
		"\t</array>",
		"\t<key>PayloadDisplayName</key>\n\t<string>Mailflare calendar and contacts</string>",
		`\t<key>PayloadIdentifier</key>\n\t<string>com.mailflare.dav.${host}.${escapeXml(userId)}</string>`,
		"\t<key>PayloadType</key>\n\t<string>Configuration</string>",
		`\t<key>PayloadUUID</key>\n\t<string>${uuid()}</string>`,
		"\t<key>PayloadVersion</key>\n\t<integer>1</integer>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}
