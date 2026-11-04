/**
 * Attachment risk without an antivirus engine: file types that run code or carry macros, names that
 * disguise their type, and the contents of ZIP archives (bounded). It does not detect malware in
 * ordinary-looking files; it stops a one-click download of things that are dangerous by design.
 */
export type AttachmentRiskLevel = "ok" | "warning" | "blocked";
export type AttachmentRisk = { level: AttachmentRiskLevel; reasons: string[] };

/** Run code when opened. */
const EXECUTABLE = new Set([
	"exe", "scr", "com", "pif", "bat", "cmd", "msi", "msp", "dll", "cpl", "jar", "js", "jse", "vbs", "vbe", "wsf", "wsh",
	"ps1", "psm1", "lnk", "hta", "reg", "apk", "appimage", "scf", "url", "chm", "gadget", "inf", "sh", "command", "app", "pkg", "dmg",
]);
/** Office formats that carry macros. */
const MACRO = new Set(["docm", "xlsm", "pptm", "dotm", "xltm", "potm", "ppam", "xlam", "sldm"]);
/** Open in a browser or mount like a disk: common phishing and smuggling containers. */
const CONTAINER = new Set(["html", "htm", "xhtml", "shtml", "svg", "iso", "img", "vhd", "vhdx", "one"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab", "ace"]);
const DOCUMENT_LOOKING = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "jpg", "jpeg", "png", "gif", "csv", "mp3", "mp4"]);
// eslint-disable-next-line no-control-regex
const BIDI_OR_CONTROL = /[\u0000-\u001f‪-‮⁦-⁩]/;

const MAX_ZIP_ENTRIES = 1000;
const MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;
const MAX_ZIP_DEPTH_NAMES = 50;

function extensions(filename: string): string[] {
	return filename.toLowerCase().trim().split(".").slice(1).map((part) => part.replace(/\s+$/, ""));
}

const rank: Record<AttachmentRiskLevel, number> = { ok: 0, warning: 1, blocked: 2 };

export function mergeRisks(...risks: AttachmentRisk[]): AttachmentRisk {
	let level: AttachmentRiskLevel = "ok";
	const reasons: string[] = [];
	for (const risk of risks) {
		if (rank[risk.level] > rank[level]) level = risk.level;
		for (const reason of risk.reasons) if (!reasons.includes(reason)) reasons.push(reason);
	}
	return { level, reasons };
}

/** Risk judged from the name and declared type alone. */
export function assessAttachmentRisk(attachment: { filename: string; type?: string }): AttachmentRisk {
	const reasons: string[] = [];
	let level: AttachmentRiskLevel = "ok";
	const raise = (next: AttachmentRiskLevel, reason: string) => {
		if (rank[next] > rank[level]) level = next;
		reasons.push(reason);
	};
	const exts = extensions(attachment.filename);
	const last = exts[exts.length - 1] ?? "";
	if (BIDI_OR_CONTROL.test(attachment.filename)) raise("blocked", "The file name contains hidden characters that can disguise its real type.");
	if (EXECUTABLE.has(last)) raise("blocked", `.${last} files run code when opened.`);
	else if (MACRO.has(last)) raise("blocked", `.${last} documents can run macros.`);
	else if (CONTAINER.has(last)) raise("warning", `.${last} files can show a fake login page or hide other files.`);
	else if (ARCHIVE.has(last)) raise("warning", "Archives can hide other files; open them only if you expected this.");
	if (exts.length >= 2 && DOCUMENT_LOOKING.has(exts[exts.length - 2]) && (EXECUTABLE.has(last) || MACRO.has(last) || CONTAINER.has(last))) {
		raise("blocked", "The name has two extensions to look like a harmless document.");
	}
	const type = (attachment.type ?? "").toLowerCase();
	if (type === "application/x-msdownload" || type === "application/x-msdos-program" || type === "application/x-sh" || type === "application/vnd.microsoft.portable-executable") {
		raise("blocked", "The file is declared as a program.");
	}
	return { level, reasons };
}

/** Where a ZIP's central directory sits, from the last 64 KiB of the file. */
export function locateZipDirectory(tail: Uint8Array): { offset: number; size: number } | null {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
		if (view.getUint32(index, true) === 0x06054b50) return { size: view.getUint32(index + 12, true), offset: view.getUint32(index + 16, true) };
	}
	return null;
}

/** Names inside a ZIP, read from its central directory without extracting anything. */
export function inspectZipDirectory(tail: Uint8Array, centralDirectory: (offset: number, size: number) => Uint8Array | null): AttachmentRisk {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	let eocd = -1;
	for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
		if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
	}
	if (eocd < 0) return { level: "ok", reasons: [] };
	const entries = view.getUint16(eocd + 10, true);
	const size = view.getUint32(eocd + 12, true);
	const offset = view.getUint32(eocd + 16, true);
	if (size === 0xffffffff || offset === 0xffffffff || entries === 0xffff) return { level: "warning", reasons: ["This archive uses a format that cannot be checked here."] };
	if (entries > MAX_ZIP_ENTRIES || size > MAX_CENTRAL_DIRECTORY_BYTES) return { level: "warning", reasons: ["This archive holds an unusually large number of files and was not fully checked."] };
	const directory = centralDirectory(offset, size);
	if (!directory) return { level: "warning", reasons: ["This archive could not be checked."] };
	const dv = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
	const risks: AttachmentRisk[] = [];
	let encrypted = false;
	let position = 0;
	for (let seen = 0; seen < entries && position + 46 <= directory.byteLength && seen < MAX_ZIP_DEPTH_NAMES * 20; seen += 1) {
		if (dv.getUint32(position, true) !== 0x02014b50) break;
		const flags = dv.getUint16(position + 8, true);
		const nameLength = dv.getUint16(position + 28, true);
		const extraLength = dv.getUint16(position + 30, true);
		const commentLength = dv.getUint16(position + 32, true);
		if (position + 46 + nameLength > directory.byteLength) break;
		if (flags & 1) encrypted = true;
		const name = new TextDecoder().decode(directory.subarray(position + 46, position + 46 + nameLength));
		const inner = assessAttachmentRisk({ filename: name.split("/").pop() ?? name });
		if (inner.level !== "ok") risks.push({ level: inner.level, reasons: inner.reasons.map((reason) => `Inside the archive, ${name}: ${reason}`) });
		position += 46 + nameLength + extraLength + commentLength;
	}
	if (encrypted) risks.push({ level: "warning", reasons: ["This archive is password protected, so its contents could not be checked."] });
	const merged = mergeRisks(...risks);
	return { level: merged.level, reasons: merged.reasons.slice(0, 5) };
}
