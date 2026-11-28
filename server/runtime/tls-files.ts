import { readFileSync, statSync } from "node:fs";

export type CertificateFiles = { keyPath: string; certPath: string };
export type CertificateMaterial = { key: Buffer; cert: Buffer };

export function readCertificate(files: CertificateFiles): CertificateMaterial {
	return { key: readFileSync(files.keyPath), cert: readFileSync(files.certPath) };
}

const stamp = (files: CertificateFiles) => `${statSync(files.keyPath).mtimeMs}:${statSync(files.certPath).mtimeMs}`;

/**
 * Calls `apply` with the new key and certificate when either file changed (checked
 * every `intervalMs`), so a renewal by certbot or Caddy needs no restart. A change
 * that cannot be read or applied is logged and the previous certificate stays.
 */
export function watchCertificate(files: CertificateFiles, intervalMs: number, apply: (material: CertificateMaterial) => void): () => void {
	let last = stamp(files);
	const timer = setInterval(() => {
		try {
			const now = stamp(files);
			if (now === last) return;
			apply(readCertificate(files));
			last = now;
			console.log("TLS certificate reloaded");
		} catch (error) {
			console.error("TLS certificate reload failed; keeping the previous certificate", error);
		}
	}, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}
