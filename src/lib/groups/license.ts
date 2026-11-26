import { getLicenseEntitlements } from "@/lib/licenses/service";

/** Groups need accounts to be manageable (Pro and Team). Without it routing ignores groups. */
export function groupsAllowed(env: CloudflareEnv): () => Promise<boolean> {
	return async () => (await getLicenseEntitlements(env)).canManageAccounts;
}
