import { NextResponse } from "next/server";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getBranding, updateBranding } from "@/lib/branding/service";
import { isAccentColorId } from "@/lib/branding/accents";
import { getEnv } from "@/lib/cloudflare";
import { BRANDING_ICON_TYPES, isBrandingIcon, MAX_BRANDING_ICON_SIZE } from "./utils";

export async function GET() {
	return NextResponse.json(await getBranding(getEnv()), {
		headers: { "Cache-Control": "no-store" },
	});
}

export async function PUT(request: Request) {
	const env = getEnv();
	try {
		assertPrimaryAdmin(await requireUser(env, request));
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const form = await request.formData();
	const appName = String(form.get("appName") ?? "").trim();
	const accentColor = form.get("accentColor");
	const iconValue = form.get("icon");
	if (!appName || appName.length > 60) {
		return NextResponse.json({ error: "App name must be between 1 and 60 characters" }, { status: 400 });
	}
	if (!isAccentColorId(accentColor)) {
		return NextResponse.json({ error: "Unknown accent color" }, { status: 400 });
	}
	const icon = isBrandingIcon(iconValue) && iconValue.size > 0 ? iconValue : null;
	if (icon && !BRANDING_ICON_TYPES.includes(icon.type)) {
		return NextResponse.json({ error: "Use a PNG, JPEG, WebP, or GIF image" }, { status: 400 });
	}
	if (icon && icon.size > MAX_BRANDING_ICON_SIZE) {
		return NextResponse.json({ error: "Icon must be 2 MB or smaller" }, { status: 413 });
	}

	try {
		return NextResponse.json(await updateBranding(env, { appName, accentColor, icon }));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to update branding";
		const status = /license is required/i.test(message) ? 403 : 500;
		return NextResponse.json({ error: message }, { status });
	}
}
