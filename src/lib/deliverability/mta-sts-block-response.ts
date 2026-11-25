import { NextResponse } from "next/server";
import { getServerTranslator } from "@/lib/i18n/server";
import { MtaStsBlockedError } from "./mta-sts-guard";

const MESSAGE = {
	MTA_STS_ENFORCED: "mtasts.block.enforce",
	MTA_STS_PUBLISHED: "mtasts.block.published",
	TLS_RPT_ENABLED: "mtasts.block.tlsRpt",
} as const;

/** The 409 for an action the MTA-STS guard refused, with the message in the caller's language (preference cookie); null for any other error. */
export async function mtaStsBlockedResponse(error: unknown): Promise<NextResponse | null> {
	if (!(error instanceof MtaStsBlockedError)) return null;
	const t = await getServerTranslator();
	return NextResponse.json({ error: t(MESSAGE[error.code]), code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
}
