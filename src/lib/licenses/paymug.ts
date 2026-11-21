import type { LicenseActivationInput, LicenseDeactivationInput, PaymugLicenseAction, PaymugLicenseResponse } from "./types";
import { parsePaymugLicenseResponse } from "./utils";

export const PAYMUG_BASE_URL = "https://app.paymug.co";

export async function callPaymugLicenseApi(
	action: PaymugLicenseAction,
	input: LicenseActivationInput | LicenseDeactivationInput,
): Promise<PaymugLicenseResponse> {
	let response: Response;

	try {
		response = await fetch(`${PAYMUG_BASE_URL}/api/v1/licenses/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("Unable to reach Paymug. Try again later.");
	}

	if (!response.ok) {
		if (response.status === 409) {
			throw new Error("This license is active on another installation. Deactivate it there before retrying.");
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error("Paymug rejected this license key.");
		}
		if (response.status >= 500) {
			throw new Error("Paymug is temporarily unavailable. Try again later.");
		}
		throw new Error("Paymug could not process this license request.");
	}

	try {
		return parsePaymugLicenseResponse(await response.json());
	} catch {
		throw new Error("Paymug returned an invalid license response");
	}
}
