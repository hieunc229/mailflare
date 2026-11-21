// Bump OFFLINE_CACHE whenever public/offline.html changes: installed clients keep the cached copy until the cache name changes.
const OFFLINE_CACHE_PREFIX = "mailflare-offline-";
const OFFLINE_CACHE = `${OFFLINE_CACHE_PREFIX}v2`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
	console.log("[sw] installed, activating immediately");
	// A failed precache must not block install: the page is only needed once the network is gone.
	event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll([OFFLINE_URL])).catch(() => {}));
	self.skipWaiting();
});

// Cloudflare Workers assets answer /offline.html with a redirect, and browsers refuse a redirected response
// for a navigation, so the stored copy is rebuilt as a plain 200 before it is served.
function plain(response) {
	if (!response?.redirected) return response;
	return new Response(response.body, { status: 200, statusText: "OK", headers: response.headers });
}

// Only top-level page loads fall back to the offline page, and only when the network request throws.
// Responses are never written to the cache, so authenticated HTML and API data stay out of it.
self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(
		(async () => {
			try {
				return (await event.preloadResponse) || (await fetch(event.request));
			} catch {
				return plain(await caches.match(OFFLINE_URL)) || Response.error();
			}
		})(),
	);
});

self.addEventListener("activate", (event) => {
	console.log("[sw] activated, claiming clients");
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(names.filter((name) => name.startsWith(OFFLINE_CACHE_PREFIX) && name !== OFFLINE_CACHE).map((name) => caches.delete(name)));
			await self.registration.navigationPreload?.enable();
			await self.clients.claim();
			// Heal a cache the install step could not fill; not awaited so a slow network never delays activation.
			caches
				.open(OFFLINE_CACHE)
				.then(async (cache) => {
					if (!(await cache.match(OFFLINE_URL))) await cache.add(OFFLINE_URL);
				})
				.catch(() => {});
		})(),
	);
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
