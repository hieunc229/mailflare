/** Shows `count` on the installed app's icon, or clears it at zero. */
export function setAppBadgeCount(count: number): void {
	if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
	// Browsers reject outside an installed app; the badge is cosmetic, so ignore it.
	const update = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
	void update.catch(() => {});
}
