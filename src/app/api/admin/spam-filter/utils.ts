import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { checkAbuseChKey, checkSpamhausKey, getSpamIntelligenceStatus, MAX_SPAM_BRANDS, saveSpamIntelligenceSettings, spamBrandSchema } from "@/lib/spam/settings";

const keySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);

const schema = z.object({
	/** null removes the saved key. */
	spamhausDqsKey: keySchema.nullable().optional(),
	abuseChAuthKey: keySchema.nullable().optional(),
	domainAge: z.boolean().optional(),
	brands: z.array(spamBrandSchema).max(MAX_SPAM_BRANDS).optional(),
});

const noStore = { "Cache-Control": "no-store" };

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { env, error: Response.json({ error: "Forbidden" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { env, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, error: null };
}

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return Response.json(await getSpamIntelligenceStatus(access.env), { headers: noStore });
}

export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Check the keys and brands you entered" }, { status: 400 });
	const input = parsed.data;
	if (!(await getSpamIntelligenceStatus(access.env)).available) {
		return Response.json({ error: "Apply the pending database update first" }, { status: 409 });
	}

	if (input.spamhausDqsKey) {
		const valid = await checkSpamhausKey(input.spamhausDqsKey).catch(() => null);
		if (valid === null) return Response.json({ error: "Could not reach Spamhaus to check the key" }, { status: 502 });
		if (!valid) return Response.json({ error: "Spamhaus did not accept this DQS key" }, { status: 400 });
	}
	if (input.abuseChAuthKey) {
		const valid = await checkAbuseChKey(input.abuseChAuthKey).catch(() => null);
		if (valid === null) return Response.json({ error: "Could not reach abuse.ch to check the key" }, { status: 502 });
		if (!valid) return Response.json({ error: "abuse.ch did not accept this Auth-Key" }, { status: 400 });
	}

	await saveSpamIntelligenceSettings(access.env, {
		spamhausDqsKey: input.spamhausDqsKey,
		abusechAuthKey: input.abuseChAuthKey,
		spamDomainAgeCheck: input.domainAge,
		spamBrands: input.brands,
	});
	return Response.json(await getSpamIntelligenceStatus(access.env), { headers: noStore });
}
