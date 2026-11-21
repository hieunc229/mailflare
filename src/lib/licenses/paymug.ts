// Varunya Mail: Decoupled from Paymug external licensing.
// Preserves types and interfaces for internal callers without external network traffic.
import type { LicenseActivationInput, LicenseDeactivationInput, PaymugLicenseAction, PaymugLicenseResponse } from "./types";

export const PAYMUG_BASE_URL = "https://app.paymug.co";

export async function callPaymugLicenseApi(
	action: PaymugLicenseAction,
	input: LicenseActivationInput | LicenseDeactivationInput,
): Promise<PaymugLicenseResponse> {
	// Native Varunya implementation: self-hosted, fully active, zero external network dependency.
	return {
		valid: true,
		state: action === "deactivate" ? "deactivated" : "active",
		instanceId: input.instanceId,
		productId: input.productId,
		plan: "team",
		features: ["branding", "accounts", "sharing", "forwarding"],
		seatLimit: null,
	};
}

