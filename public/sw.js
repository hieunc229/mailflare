self.addEventListener("install", () => {
	console.log("[sw] installed, activating immediately");
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	console.log("[sw] activated, claiming clients");
	event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

const DEFAULT_NOTIFICATION = {
	title: "New email",
	body: "You have a new message",
	icon: "/icon-192.png",
	badge: "/icon-96.png",
	url: "/inbox",
};

async function syncAppBadge() {
	if (!("setAppBadge" in self.navigator)) return;
	try {
		const response = await fetch("/api/messages/counts", { credentials: "include" });
		if (!response.ok) return;
		const unread = (await response.json())?.counts?.folders?.inbox?.unread;
		if (typeof unread !== "number") return;
		await (unread > 0 ? self.navigator.setAppBadge(unread) : self.navigator.clearAppBadge());
	} catch {
		// Leave the badge as it was when the network is down or the API rejects outside an installed app.
	}
}

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			if (windows.some((client) => client.visibilityState === "visible")) return;

			let payload = DEFAULT_NOTIFICATION;
			try {
				payload = { ...DEFAULT_NOTIFICATION, ...(event.data?.json() ?? {}) };
			} catch {
				// Keep the generic notification if a provider delivers an empty or malformed payload.
			}

			await Promise.all([
				self.registration.showNotification(payload.title, {
					body: payload.body,
					icon: payload.icon,
					badge: payload.badge,
					tag: payload.tag,
					data: { url: payload.url },
				}),
				syncAppBadge(),
			]);
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || "/inbox", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				if (client.url.startsWith(self.location.origin)) {
					await client.focus();
					await client.navigate(target);
					return;
				}
			}
			await self.clients.openWindow(target);
		})(),
	);
});
