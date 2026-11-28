import { notFound } from "next/navigation";
import { FolderShell } from "./folder-shell";
import { type FolderSlug, folderSlugs } from "./folder-slugs";

export const generateStaticParams = () => folderSlugs.map((folder) => ({ folder }));
export const dynamicParams = false;

export default async function FolderLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ folder: string }>;
}) {
	const { folder } = await params;
	// dynamicParams=false is not enforced everywhere (the Node build, nested message routes on Workers), so check here too.
	if (!(folderSlugs as readonly string[]).includes(folder)) notFound();
	return <FolderShell folder={folder as FolderSlug}>{children}</FolderShell>;
}
