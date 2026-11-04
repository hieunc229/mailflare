import assert from "node:assert/strict";
import test from "node:test";

import { getImapChunkSize, planImapFetchGroups, growImapChunkSize, isPermanentImapError, isMissingImapFolderError } from "../src/lib/import/imap-utils.ts";

test("chunk size defaults to the base and never exceeds it", () => {
	assert.equal(getImapChunkSize(50, undefined), 50);
	assert.equal(getImapChunkSize(50, 500), 50);
});

test("each redelivery halves the chunk, down to one message", () => {
	assert.equal(getImapChunkSize(50, undefined, 2), 25);
	assert.equal(getImapChunkSize(50, 20, 3), 5);
	assert.equal(getImapChunkSize(50, 3, 9), 1);
});

test("a clean chunk climbs back towards the base", () => {
	assert.equal(growImapChunkSize(50, 1), 2);
	assert.equal(growImapChunkSize(50, 20), 30);
	assert.equal(growImapChunkSize(50, 40), 50);
	assert.equal(growImapChunkSize(50, 50), 50);
});

test("credential errors are not retried smaller", () => {
	assert.equal(isPermanentImapError("IMAP command failed: A0002 NO [AUTHENTICATIONFAILED] Invalid credentials"), true);
	assert.equal(isPermanentImapError("IMAP connection closed unexpectedly"), false);
});

test("fetch groups pipeline small mail, split big mail and drop the tail past the budget", () => {
	const mb = 1024 * 1024;
	const uids = ["5", "4", "3", "2", "1"];
	const small = new Map(uids.map((uid) => [uid, 1000]));
	assert.deepEqual(planImapFetchGroups(uids, small), [uids]);
	const big = new Map([["5", 8 * mb], ["4", 2 * mb], ["3", 8 * mb], ["2", 8 * mb], ["1", 8 * mb]]);
	assert.deepEqual(planImapFetchGroups(uids, big).flat(), ["5", "4", "3", "2"]);
	assert.deepEqual(planImapFetchGroups(["2", "1"], new Map([["1", 5]])), [["2"]]);
});

test("a folder the server cannot open is detected so the import can skip it", () => {
	assert.equal(isMissingImapFolderError("IMAP command failed: A0002 NO [NONEXISTENT] Unknown Mailbox: [Gmail] (Failure)"), true);
	assert.equal(isMissingImapFolderError("IMAP connection closed unexpectedly"), false);
});
