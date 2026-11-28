import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { getPublicDriveItem } from "@/lib/drive/access";
import { buildPublicDriveListing } from "@/lib/drive/public-listing";
import { PublicDriveClient } from "./public-drive-client";

export const dynamic = "force-dynamic";

export default async function PublicDrivePage({ params }: { params: Promise<{ token: string }> }) {
	const { token } = await params;
	const db = getDb(getEnv());
	const resolved = await getPublicDriveItem(db, token);
	const initial = resolved ? await buildPublicDriveListing(db, resolved.root, resolved.item) : null;
	return <PublicDriveClient token={token} initial={initial} />;
}
