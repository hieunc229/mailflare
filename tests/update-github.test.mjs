import assert from "node:assert/strict";
import test from "node:test";

import { commitsBehind, shouldRetryGitHubAnonymously } from "../src/app/api/admin/update/github-utils.ts";

test("a token 404 on the public upstream repository is read again without credentials", () => {
	assert.equal(shouldRetryGitHubAnonymously("/repos/hieunc229/mailflare/contents/package.json", 404), true);
	assert.equal(shouldRetryGitHubAnonymously("/repos/hieunc229/mailflare/compare/main...owner:main", 404), true);
});

test("the installation repository keeps the token when GitHub says it is missing", () => {
	assert.equal(shouldRetryGitHubAnonymously("/repos/JoaoMarcosSampaio/mailflare", 404), false);
	assert.equal(shouldRetryGitHubAnonymously("/repos/hieunc229/mailflare/contents/package.json", 200), false);
});

test("commits ahead of a shared upstream history are not counted as missing", () => {
	const installation = new Set(["local", "upstream-head", "older"]);
	assert.equal(commitsBehind(["upstream-head", "older"], installation), 0);
	assert.equal(commitsBehind(["new", "upstream-head", "older"], installation), 1);
	assert.equal(commitsBehind(["unrelated"], installation), null);
});
