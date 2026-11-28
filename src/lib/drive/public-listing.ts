import { and, eq, isNull } from "drizzle-orm";
import type { getDb } from "@/db";
import { driveItems } from "@/db/schema";
import type { PublicDriveListing } from "@/app/d/[token]/types";
import { getDriveChain } from "./access";
import type { DriveRow } from "./types";

type Db = ReturnType<typeof getDb>;

const publicItem = (row: DriveRow) => ({ id: row.id, kind: row.kind, name: row.name, size: row.size, contentType: row.contentType, updatedAt: row.updatedAt.toISOString() });

/** What an unauthenticated visitor of a share link sees: the item, its visible children and the path from the share root. */
export async function buildPublicDriveListing(db: Db, root: DriveRow, item: DriveRow): Promise<PublicDriveListing> {
	const children = item.kind === "folder" ? await db.select().from(driveItems).where(and(eq(driveItems.parentId, item.id), isNull(driveItems.trashedAt), isNull(driveItems.uploadId))) : [];
	const chain = await getDriveChain(db, item);
	const path = chain.slice(chain.findIndex((entry) => entry.id === root.id)).map((entry) => ({ id: entry.id, name: entry.name }));
	return { item: publicItem(item), items: children.map(publicItem), path };
}
