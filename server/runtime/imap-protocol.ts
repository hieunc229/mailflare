export type ImapSessionState = "not-authenticated" | "authenticated" | "logged-out";
export type ImapCommand = { tag: string; verb: string; args: string[] };
export type ImapAction = { response: string; state?: ImapSessionState; login?: { username: string; password: string } };

/** Parse an IMAP command line. Quoted strings support backslash escapes; literals are supplied by the socket layer as quoted values. */
export function quoteImapLiteral(value: string): string {
	return `"${value.replace(/["\\\\]/g, (char) => `\\${char}`)}"`;
}

export function parseImapCommand(line: string): ImapCommand | null {
	const tokens: string[] = [];
	let i = 0;
	while (i < line.length) {
		while (line[i] === " " || line[i] === "\t") i++;
		if (i >= line.length) break;
		if (line[i] === '"') {
			i++;
			let value = "";
			let closed = false;
			while (i < line.length) {
				const char = line[i++];
				if (char === '"') { closed = true; break; }
				if (char === "\\") {
					if (i >= line.length) return null;
					value += line[i++];
				} else value += char;
			}
			if (!closed || (i < line.length && line[i] !== " " && line[i] !== "\t")) return null;
			tokens.push(value);
		} else {
			const start = i;
			while (i < line.length && line[i] !== " " && line[i] !== "\t") i++;
			tokens.push(line.slice(start, i));
		}
	}
	if (tokens.length < 2 || !/^[^\s{}]+$/.test(tokens[0])) return null;
	return { tag: tokens[0], verb: tokens[1].toUpperCase(), args: tokens.slice(2) };
}

/** Produce one protocol action. LOGIN is an event for the server to authenticate asynchronously. */
export function dispatchImapCommand(state: ImapSessionState, command: ImapCommand): ImapAction {
	const { tag, verb, args } = command;
	if (verb === "CAPABILITY") return { response: `* CAPABILITY IMAP4rev1 ID\r\n${tag} OK CAPABILITY completed\r\n` };
	if (verb === "NOOP") return { response: `${tag} OK NOOP completed\r\n` };
	if (verb === "LOGOUT") return { response: `* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`, state: "logged-out" };
	if (verb === "ID") return { response: `* ID (\"name\" \"Mailflare\")\r\n${tag} OK ID completed\r\n` };
	if (verb === "LOGIN") {
		if (state !== "not-authenticated") return { response: `${tag} BAD LOGIN only valid before authentication\r\n` };
		if (args.length !== 2) return { response: `${tag} BAD LOGIN requires username and password\r\n` };
		return { response: "", login: { username: args[0], password: args[1] } };
	}
	if (state === "not-authenticated") return { response: `${tag} BAD Authenticate first\r\n` };
	return { response: `${tag} NO Not implemented yet\r\n` };
}

export function loginResult(tag: string, authenticated: boolean): ImapAction {
	return authenticated
		? { response: `${tag} OK LOGIN completed\r\n`, state: "authenticated" }
		: { response: `${tag} NO Authentication failed\r\n` };
}
