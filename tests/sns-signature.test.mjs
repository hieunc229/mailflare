import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-sns-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/aws/sns-signature.ts")],
	outfile: join(dir, "sns.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
});
const { verifySnsSignature, isValidSigningCertUrl } = await import(pathToFileURL(join(dir, "sns.mjs")).href);

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=sns.test", "-days", "2"], { stdio: "ignore" });
const keyPem = readFileSync(join(dir, "key.pem"), "utf8");
const certPem = readFileSync(join(dir, "cert.pem"), "utf8");
const der = Buffer.from(certPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
const loadCertificate = async () => der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);

const base = { Type: "Notification", MessageId: "m-1", TopicArn: "arn:aws:sns:us-east-1:1:t", Message: "{}", Timestamp: new Date().toISOString(), SignatureVersion: "2", SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem" };
function sign(envelope, algorithm = "RSA-SHA256") {
	const signer = createSign(algorithm);
	signer.update(["Message", "MessageId", "Timestamp", "TopicArn", "Type"].map((key) => `${key}\n${envelope[key]}\n`).join(""));
	return signer.sign(keyPem, "base64");
}

test("accepts a correctly signed notification and rejects tampering", async () => {
	const envelope = { ...base, Signature: sign(base) };
	assert.equal(await verifySnsSignature(envelope, { loadCertificate }), true);
	assert.equal(await verifySnsSignature({ ...envelope, Message: "{\"x\":1}" }, { loadCertificate }), false);
	assert.equal(await verifySnsSignature({ ...envelope, TopicArn: "arn:other" }, { loadCertificate }), false);
});

test("accepts SignatureVersion 1 (SHA-1)", async () => {
	const v1 = { ...base, SignatureVersion: "1" };
	assert.equal(await verifySnsSignature({ ...v1, Signature: sign(v1, "RSA-SHA1") }, { loadCertificate }), true);
});

test("rejects stale timestamps, missing signatures and foreign certificate URLs", async () => {
	const old = { ...base, Timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() };
	assert.equal(await verifySnsSignature({ ...old, Signature: sign(old) }, { loadCertificate }), false);
	assert.equal(await verifySnsSignature(base, { loadCertificate }), false);
	for (const url of ["http://sns.us-east-1.amazonaws.com/c.pem", "https://evil.example/c.pem", "https://sns.us-east-1.amazonaws.com.evil.example/c.pem", "https://sns.us-east-1.amazonaws.com:8443/c.pem", "https://sns.us-east-1.amazonaws.com/c.txt"]) {
		assert.equal(isValidSigningCertUrl(url), false, url);
	}
	assert.equal(isValidSigningCertUrl("https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem"), true);
});
