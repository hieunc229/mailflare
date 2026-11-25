import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { authenticate, dkimSign } from "mailauth";

// server/runtime/smtp-auth.ts reads `spf.status.result`, `dkim.results[].status.result` and `dmarc.status.result`
// from authenticate(). This pins that result shape (with DNS answered locally) so a mailauth upgrade that moves them fails here.
const records = {
	"example.com:TXT": [["v=spf1 ip4:203.0.113.5 -all"]],
	"_dmarc.example.com:TXT": [["v=DMARC1; p=none"]],
};
const resolver = async (name, rrtype) => {
	const answer = records[`${name}:${rrtype}`];
	if (answer) return answer;
	throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
};
const raw = Buffer.from("From: Bob <bob@example.com>\r\nTo: you@example.net\r\nSubject: Hi\r\nDate: Wed, 25 Nov 2026 10:00:00 +0000\r\nMessage-ID: <1@example.com>\r\n\r\nHello\r\n");

test("authenticate() keeps the SPF, DKIM and DMARC result paths the SMTP listener reads", async () => {
	const result = await authenticate(raw, { ip: "203.0.113.5", helo: "mail.example.com", sender: "bob@example.com", mta: "mx.example.net", resolver, disableArc: true, disableBimi: true });
	assert.equal(result.spf.status.result, "pass");
	assert.ok(Array.isArray(result.dkim.results), "dkim.results is a list");
	assert.ok(result.dkim.results.every((entry) => !entry.status?.result || typeof entry.status.result === "string"));
	assert.equal(result.dmarc.status.result, "pass");
});

test("an SPF failure surfaces as spf fail and a failed DMARC", async () => {
	const result = await authenticate(raw, { ip: "198.51.100.9", helo: "mail.example.com", sender: "bob@example.com", mta: "mx.example.net", resolver, disableArc: true, disableBimi: true });
	assert.equal(result.spf.status.result, "fail");
	assert.equal(result.dmarc.status.result, "fail");
});

test("a DKIM-signed message reports dkim.results[0].status.result pass", async () => {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const p = publicKey.export({ type: "spki", format: "der" }).toString("base64");
	const dkimResolver = (name, rrtype) => name === "sel._domainkey.example.com" && rrtype === "TXT" ? Promise.resolve([[`v=DKIM1; k=rsa; p=${p}`]]) : resolver(name, rrtype);
	const signed = await dkimSign(raw, { signatureData: [{ signingDomain: "example.com", selector: "sel", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
	assert.equal(signed.errors.length, 0);
	const message = Buffer.concat([Buffer.from(signed.signatures), raw]);
	const result = await authenticate(message, { ip: "198.51.100.9", helo: "mail.example.com", sender: "bob@example.com", mta: "mx.example.net", resolver: dkimResolver, disableArc: true, disableBimi: true });
	assert.equal(result.dkim.results[0].status.result, "pass");
	assert.equal(result.dmarc.status.result, "pass", "DKIM alignment alone passes DMARC");
});
