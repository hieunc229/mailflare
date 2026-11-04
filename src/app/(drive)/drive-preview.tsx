"use client";

import { Download } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { canPreview } from "./drive-utils";

export function DrivePreviewBody({ src, downloadHref, contentType, name }: { src: string; downloadHref: string; contentType: string; name: string }) {
	const { t } = useLanguage();
	if (!canPreview(contentType)) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-[#e8eaed]">
				<p>{t("drive.noPreview")}</p>
				<a href={downloadHref} className="inline-flex items-center gap-2 rounded-full bg-[#e8eaed] px-4 py-2 font-medium text-[#202124]"><Download size={16} />{t("drive.download")}</a>
			</div>
		);
	}
	if (contentType.startsWith("image/")) return <img src={src} alt={name} className="mx-auto max-h-full max-w-full object-contain" />;
	if (contentType.startsWith("video/")) return <video src={src} controls className="mx-auto max-h-full max-w-full" />;
	if (contentType.startsWith("audio/")) return <div className="flex h-full items-center justify-center"><audio src={src} controls /></div>;
	return <iframe src={src} title={name} className="h-full w-full rounded-lg" style={{ background: "#fff", colorScheme: "light" }} />;
}
