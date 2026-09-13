import {
	deleteEmailRoutingRule,
	listEmailRoutingRules,
} from "@/lib/cloudflare-api";

function routesToDomain(ruleValue: string | undefined, hostname: string): boolean {
	if (!ruleValue) return false;

	const normalized = ruleValue.toLowerCase();
	return normalized === hostname || normalized.endsWith(`@${hostname}`);
}

export async function deleteEmailRoutingRulesForDomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<void> {
	if (zoneId === "manual") return;
	const normalizedHostname = hostname.toLowerCase();
	const rules = await listEmailRoutingRules(env, zoneId);
	const linkedRules = rules.filter((rule) =>
		rule.matchers?.some(
			(matcher) =>
				matcher.type === "literal" &&
				matcher.field === "to" &&
				routesToDomain(matcher.value, normalizedHostname),
		),
	);

	await Promise.all(
		linkedRules.map(async (rule) => {
			const ruleId = rule.id ?? rule.tag;
			if (!ruleId) return;

			await deleteEmailRoutingRule(env, zoneId, ruleId);
		}),
	);
}
