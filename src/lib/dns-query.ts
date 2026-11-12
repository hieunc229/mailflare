export type DnsQueryType = "MX" | "TXT" | "A" | "AAAA" | "CNAME";

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
	TXT: 16,
};

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
