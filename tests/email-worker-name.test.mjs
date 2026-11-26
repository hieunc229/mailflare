import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getEmailWorkerName } = await import(pathToFileURL(join(root, "src/lib/cloudflare-api-utils.ts")).href);

test("getEmailWorkerName defaults to mailflare", () => {
	assert.equal(getEmailWorkerName({}), "mailflare");
	assert.equal(getEmailWorkerName({ CF_EMAIL_WORKER_NAME: "  " }), "mailflare");
});

test("getEmailWorkerName honours CF_EMAIL_WORKER_NAME", () => {
	assert.equal(getEmailWorkerName({ CF_EMAIL_WORKER_NAME: "my-mail" }), "my-mail");
});
