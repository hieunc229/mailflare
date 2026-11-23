import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getAvatarImageResponse, getOptimizedAvatarFiles, storeAvatarImages } from "@/lib/avatar-images";
import { avatarKeyFor } from "@/app/api/profile/avatar/utils";
import type { AccountRouteParams } from "../types";
import { getManagedAccount } from "./utils";
import { requireTeamAdmin } from "../../utils";
import { selectAccountById } from "../utils";

export async function GET(request: Request, { params }: AccountRouteParams) {
	const { id } = await params;
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account?.avatarKey) return new Response("Not found", { status: 404 });
	return getAvatarImageResponse(request, access.env.BUCKET, account.avatarKey);
}

export async function POST(request: Request, { params }: AccountRouteParams) {
	const { id } = await params;
	const { access, account } = await getManagedAccount(request, id);
	if (access.error) return access.error;
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
	}
	const images = getOptimizedAvatarFiles(form);
	if (!images) return NextResponse.json({ error: "A resized WebP image and preview are required" }, { status: 400 });
	const key = avatarKeyFor(account.id);
	await storeAvatarImages(access.env.BUCKET, key, images.full, images.preview);
	await getDb(access.env).update(users).set({ avatarKey: key }).where(eq(users.id, account.id));
	return NextResponse.json({ ok: true });
}
