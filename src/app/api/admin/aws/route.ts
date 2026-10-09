import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { AWS_IAM_POLICY, AwsCredentialsError, validateAwsConfig } from "@/lib/aws/validate";
import { clearAwsConfig, getAwsConfig, getAwsConfigStatus, saveAwsConfig } from "@/lib/aws/config";

const schema = z.object({
	accessKeyId: z.string().trim().regex(/^[A-Z0-9]{16,128}$/, "That does not look like an AWS access key ID"),
	secretAccessKey: z.string().trim().min(20).max(200),
	region: z.string().trim().toLowerCase(),
});

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { env, error: Response.json({ error: "Only the primary administrator can manage AWS credentials" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { env, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, error: null };
}

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return Response.json({ status: await getAwsConfigStatus(access.env), policy: AWS_IAM_POLICY }, { headers: noStore });
}

/** Validates the credentials against AWS before saving them. */
export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Enter an access key ID, secret and region" }, { status: 400 });
	try {
		const report = await validateAwsConfig(parsed.data);
		if (!report.sending && !report.receiving) {
			return Response.json({ error: "These credentials work but have no SES permissions. Attach the policy shown below.", report, policy: AWS_IAM_POLICY }, { status: 400 });
		}
		await saveAwsConfig(access.env, parsed.data, report.accountId);
		return Response.json({ status: await getAwsConfigStatus(access.env), report }, { headers: noStore });
	} catch (error) {
		if (error instanceof AwsCredentialsError) return Response.json({ error: error.message }, { status: 400 });
		return Response.json({ error: error instanceof Error ? error.message : "Could not reach AWS" }, { status: 502 });
	}
}

/** Re-runs the capability checks against the saved credentials. */
export async function POST(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const config = await getAwsConfig(access.env);
	if (!config) return Response.json({ error: "No AWS credentials are configured" }, { status: 400 });
	try {
		return Response.json({ report: await validateAwsConfig(config) }, { headers: noStore });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not reach AWS" }, { status: error instanceof AwsCredentialsError ? 400 : 502 });
	}
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	await clearAwsConfig(access.env);
	return Response.json({ status: await getAwsConfigStatus(access.env) }, { headers: noStore });
}
