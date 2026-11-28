const avatarColors = [
	{ background: "#FFCDD2", foreground: "#202124" },
	{ background: "#F8BBD0", foreground: "#202124" },
	{ background: "#E1BEE7", foreground: "#202124" },
	{ background: "#C5CAE9", foreground: "#202124" },
	{ background: "#BBDEFB", foreground: "#202124" },
	{ background: "#B2DFDB", foreground: "#202124" },
	{ background: "#C8E6C9", foreground: "#202124" },
	{ background: "#FFE0B2", foreground: "#202124" },
	{ background: "#D7CCC8", foreground: "#202124" },
	{ background: "#CFD8DC", foreground: "#202124" },
];

export function getAvatarColorStyle(identity: string): { backgroundColor: string; color: string } {
	let hash = 0;
	const stableIdentity = identity.trim().toLowerCase();

	for (let i = 0; i < stableIdentity.length; i++) {
		hash = (Math.imul(hash, 31) + stableIdentity.charCodeAt(i)) | 0;
	}

	const color = avatarColors[(hash >>> 0) % avatarColors.length];
	return { backgroundColor: color.background, color: color.foreground };
}

/** First user-perceived character of a name, upper-cased; whole code points so emoji are not split. */
export function avatarInitial(value: string): string {
	const first = Array.from(value.trim())[0];
	return first ? first.toUpperCase() : "";
}
