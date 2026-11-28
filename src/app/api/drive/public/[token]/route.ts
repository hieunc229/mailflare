import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { getPublicDriveItem } from "@/lib/drive/access";
import { buildPublicDriveListing } from "@/lib/drive/public-listing";
import { streamDriveFile } from "@/lib/drive/content";
import type { DriveTokenParams } from "./types";

/** Public, unauthenticated access to an item (and its subtree) shared by link. */
export async function GET(request: Request, { params }: DriveTokenParams) {
	const { token } = await params;
	const env = getEnv();
	const db = getDb(env);
	const url = new URL(request.url);
	const target = url.searchParams.get("item");
	const resolved = await getPublicDriveItem(db, token, target);
	if (!resolved) return NextResponse.json({ error: "Link not found" }, { status: 404 });
	const { root, item } = resolved;
	if (url.searchParams.get("content") === "1" || url.searchParams.get("download") === "1") {
		return streamDriveFile(env, request, item, url.searchParams.get("download") === "1");
	}
	return NextResponse.json(await buildPublicDriveListing(db, root, item));
}
