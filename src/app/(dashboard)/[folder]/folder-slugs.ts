/** Folders served by the [folder] route. Static siblings such as /compose and /inbox take precedence over it. */
export const folderSlugs = ["archived", "promotions", "sent", "spam", "starred", "trash", "snoozed", "scheduled"] as const;

export type FolderSlug = (typeof folderSlugs)[number];
