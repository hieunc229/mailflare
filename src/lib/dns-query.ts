export type DnsQueryType = "MX" | "TXT" | "A" | "AAAA" | "CNAME" | "PTR";

type DohAnswer = {
	name: string;
	type: number;
	TTL: number;
	data: string;
};

type DohResponse = {
	Status: number;
	Answer?: DohAnswer[];
};

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;

const DNS_RECORD_TYPES: Record<DnsQueryType, number> = {
	A: 1,
	AAAA: 28,
	CNAME: 5,
	MX: 15,
	PTR: 12,
	TXT: 16,
};

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The eight 16-bit groups of an IPv6 literal (`::` and a trailing IPv4 allowed), or null. */
function ipv6Groups(ip: string): number[] | null {
	let text = ip;
	const tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
	if (tail) {
		if (!IPV4.test(tail)) return null;
		const [a, b, c, d] = tail.split(".").map(Number);
		text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) => (part === "" ? [] : part.split(":"));
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/** The PTR query name for an IPv4 or IPv6 literal, or null when the text is not an IP address. */
export function reverseName(ip: string): string | null {
	if (IPV4.test(ip)) return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
	if (!ip.includes(":")) return null;
	const groups = ipv6Groups(ip);
	if (!groups) return null;
	const nibbles = groups.map((group) => group.toString(16).padStart(4, "0")).join("");
	return `${[...nibbles].reverse().join(".")}.ip6.arpa`;
}

function decodeTxt(data: string): string {
	const chunks = data.match(/"([^"]*)"/g);
	if (!chunks) return data.trim();
	return chunks.map((chunk) => chunk.slice(1, -1)).join("");
}

/**
 * Resolves a name over DNS-over-HTTPS so the same code path works on Workers
 * (no Node `dns` module) and in the self-hosted runtime. `NXDOMAIN` and an
 * empty `NOERROR` answer both map to an empty list; any other failure throws so
 * callers can tell "missing" apart from "could not check".
 */
export async function queryDns(name: string, type: DnsQueryType): Promise<string[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
	try {
		const response = await fetch(
			`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`,
			{
				headers: { accept: "application/dns-json" },
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(`DNS query for ${name} ${type} failed (${response.status})`);
		}
		const json = (await response.json()) as DohResponse;
		if (json.Status !== 0 && json.Status !== 3) {
			throw new Error(`DNS query for ${name} ${type} returned status ${json.Status}`);
		}
		// An A/AAAA lookup answers with a first CNAME record alongside the
		// requested type, so keep only records that match what was asked for.
		// Reporting CNAME names where IPs are expected makes callers treat host
		// names as addresses and reject them.
		return (json.Answer ?? [])
			.filter((answer) => answer.type === DNS_RECORD_TYPES[type])
			.map((answer) => (type === "TXT" ? decodeTxt(answer.data) : answer.data));
	} finally {
		clearTimeout(timeout);
	}
}
