"use client";

import { useEffect } from "react";
import { registerMailflareServiceWorker } from "@/lib/push/client";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function PwaServiceWorker() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		let cancelled = false;
		const cleanups: Array<() => void> = [];
		let timer: ReturnType<typeof setInterval> | undefined;
		const hadController = Boolean(navigator.serviceWorker.controller);

		const checkForUpdate = (registration: ServiceWorkerRegistration) => {
			registration.update().catch((error) => {
				console.warn("[pwa] update check failed", error);
			});
		};

		const watchInstalling = (registration: ServiceWorkerRegistration) => {
			const worker = registration.installing;
			if (!worker) return;
			console.log("[pwa] new version available, downloading");
			worker.addEventListener("statechange", () => {
				if (worker.state === "installed") {
					console.log("[pwa] new version ready");
					// The worker normally skips waiting itself; this covers one that was already waiting.
					registration.waiting?.postMessage({ type: "SKIP_WAITING" });
				}
			});
		};

		const onControllerChange = () => {
			// The first claim of a fresh install is not an update.
			if (!hadController) return;
			console.log("[pwa] new version active; it applies fully on next reload");
		};
		navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

		void registerMailflareServiceWorker()
			.then((registration) => {
				if (cancelled) return;
				console.log("[pwa] service worker registered");
				registration.addEventListener("updatefound", () => watchInstalling(registration));
				if (registration.waiting && navigator.serviceWorker.controller) {
					registration.waiting.postMessage({ type: "SKIP_WAITING" });
				}
				timer = setInterval(() => checkForUpdate(registration), UPDATE_CHECK_INTERVAL_MS);
				const onVisible = () => {
					if (document.visibilityState === "visible") checkForUpdate(registration);
				};
				document.addEventListener("visibilitychange", onVisible);
				cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
			})
			.catch((error) => {
				console.warn("Mailflare service worker registration failed", error);
			});

		return () => {
			cancelled = true;
			if (timer) clearInterval(timer);
			navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
			cleanups.forEach((fn) => fn());
		};
	}, []);

	return null;
}
