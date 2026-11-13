import { eq } from "drizzle-orm";
import packageJson from "../../../package.json";
import { getDb } from "@/db";
import { licenseSettings } from "@/db/schema";
import { LICENSE_PRODUCT_IDS } from "./constants";
import { callPaymugLicenseApi } from "./paymug";
import type { LicenseEntitlements, LicensePlan, LicenseStatus, PaymugLicenseAction } from "./types";
import { hashLicenseKey, normalizeLicensePlan, parseFeatures } from "./utils";

const LICENSE_SETTINGS_ID = "default";

async function getOrCreateLicenseSettings(env: CloudflareEnv) {
	const db = getDb(env);
	// Read first: the common path is a licensed or already-initialized install,
	// and an upsert on every request is a write on the read path.
	const [existing] = await db
		.select()
		.from(licenseSettings)
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID))
		.limit(1);
	if (existing) return existing;

	await db
		.insert(licenseSettings)
		.values({ id: LICENSE_SETTINGS_ID, instanceId: crypto.randomUUID() })
		.onConflictDoNothing({ target: licenseSettings.id });
	const [settings] = await db
		.select()
		.from(licenseSettings)
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID))
		.limit(1);
	if (!settings) throw new Error("Unable to initialize license settings");
	return settings;
}

function toLicenseStatus(settings: typeof licenseSettings.$inferSelect): LicenseStatus {
	const active = settings.state === "active" && (settings.plan === "pro" || settings.plan === "team");
	return {
		plan: active ? settings.plan : "community",
		state: settings.state,
		features: parseFeatures(settings.features),
		seatLimit: active && settings.plan === "pro" ? settings.seatLimit : null,
		instanceId: settings.instanceId,
		instanceUrl: settings.instanceUrl,
		active,
		activatedAt: settings.activatedAt,
		validatedAt: settings.validatedAt,
	};
}

export async function getLicenseStatus(env: CloudflareEnv): Promise<LicenseStatus> {
	return toLicenseStatus(await getOrCreateLicenseSettings(env));
}

export async function getLicenseEntitlements(env: CloudflareEnv): Promise<LicenseEntitlements> {
	try {
		const status = await getLicenseStatus(env);
		// Pro adds accounts up to its seat limit; Team is unlimited and also unlocks shared mailboxes.
		return {
			plan: status.plan,
			canCustomizeBranding: status.active,
			canManageAccounts: status.active,
			canShareMailboxes: status.active && status.plan === "team",
			accountSeatLimit: status.seatLimit,
			canForwardEmail: status.active,
		};
	} catch {
		return { plan: "community", canCustomizeBranding: false, canManageAccounts: false, canShareMailboxes: false, accountSeatLimit: 0, canForwardEmail: false };
	}
}

async function updateLicenseFromPaymug(
	env: CloudflareEnv,
	action: PaymugLicenseAction,
	licenseKey: string,
	instanceUrl: string,
	requestedPlan?: Exclude<LicensePlan, "community">,
): Promise<LicenseStatus> {
	const settings = await getOrCreateLicenseSettings(env);
	const licenseKeyHash = licenseKey ? await hashLicenseKey(licenseKey) : null;
	if (action === "validate" && (!licenseKeyHash || settings.licenseKeyHash !== licenseKeyHash)) {
		throw new Error("This key does not match the activated license");
	}


	const expectedPlan = action === "activate"
		? requestedPlan
		: settings.plan === "pro" || settings.plan === "team"
			? settings.plan
			: null;
	if (!expectedPlan) throw new Error("Choose the license product to activate");

	const result = await callPaymugLicenseApi(
		action,
		action === "deactivate"
			? { productId: LICENSE_PRODUCT_IDS[expectedPlan], instanceId: settings.instanceId }
			: {
					licenseKey,
					productId: LICENSE_PRODUCT_IDS[expectedPlan],
					instanceId: settings.instanceId,
					instanceUrl: action === "activate" ? instanceUrl : settings.instanceUrl ?? instanceUrl,
					appVersion: packageJson.version,
				},
	);
	const now = new Date();
	const db = getDb(env);

	if (action === "deactivate") {
		if (result.state !== "deactivated") throw new Error("Paymug did not confirm deactivation");
		await db
			.update(licenseSettings)
			.set({
				licenseKeyHash: null,
				plan: "community",
				state: "deactivated",
				features: "[]",
				seatLimit: 1,
				validatedAt: now,
				updatedAt: now,
			})
			.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID));
		return getLicenseStatus(env);
	}

	const responsePlan = normalizeLicensePlan(result.productId, result.plan);
	const plan = expectedPlan;
	const responseDoesNotMatch = (!!result.productId && responsePlan === null)
		|| (!!result.productId && responsePlan !== expectedPlan);
	if (!result.valid || result.state !== "active" || responseDoesNotMatch) {
		if (action === "validate") {
			await db
				.update(licenseSettings)
				.set({ state: result.state === "active" ? "invalid" : result.state, validatedAt: now, updatedAt: now })
				.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID));
		}
		throw new Error(result.state === "expired" ? "This license has expired" : "This license is not valid for this installation");
	}

	await db
		.update(licenseSettings)
		.set({
			licenseKeyHash: licenseKeyHash ?? settings.licenseKeyHash,
			instanceUrl: action === "activate" ? instanceUrl : settings.instanceUrl,
			instanceId: result.instanceId ?? settings.instanceId,
			plan,
			state: "active",
			features: JSON.stringify(result.features ?? []),
			seatLimit: result.seatLimit === undefined ? settings.seatLimit : result.seatLimit,
			activatedAt: action === "activate" ? now : settings.activatedAt,
			validatedAt: now,
			updatedAt: now,
		})
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID));

	return getLicenseStatus(env);
}

export function activateLicense(
	env: CloudflareEnv,
	licenseKey: string,
	instanceUrl: string,
	plan: Exclude<LicensePlan, "community">,
) {
	return updateLicenseFromPaymug(env, "activate", licenseKey, instanceUrl, plan);
}

export function validateLicense(env: CloudflareEnv, licenseKey: string, instanceUrl: string) {
	return updateLicenseFromPaymug(env, "validate", licenseKey, instanceUrl);
}

export function deactivateLicense(env: CloudflareEnv) {
	return updateLicenseFromPaymug(env, "deactivate", "", "");
}
