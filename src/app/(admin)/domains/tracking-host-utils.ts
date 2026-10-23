/**
 * Loads the pixel through the hostname like a mail client would. Image loads
 * need no CORS, so this tells whether the host reaches this Worker over HTTPS.
 */
export function probeTrackingHost(hostname: string, timeoutMs = 8000): Promise<boolean> {
	return new Promise((resolve) => {
		const image = new Image();
		const timer = window.setTimeout(() => finish(false), timeoutMs);
		function finish(ok: boolean) {
			window.clearTimeout(timer);
			image.onload = null;
			image.onerror = null;
			resolve(ok);
		}
		image.onload = () => finish(image.naturalWidth === 1 && image.naturalHeight === 1);
		image.onerror = () => finish(false);
		image.src = `https://${hostname}/api/i/probe.gif?t=${Date.now()}`;
	});
}
