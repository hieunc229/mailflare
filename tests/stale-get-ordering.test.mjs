import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLatestRequestGate } from "../src/lib/client/latest-request.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The ordering these screens hit: a list GET leaves before a mutation, the
// mutation's own reload leaves after it, and the older request settles last
// with the pre-mutation snapshot. Resolution is modelled as plain writes so the
// ordering, not network timing, is what the assertions pin down.

test("ungated, the older list response overwrites the newer one", () => {
	let items = ["kept", "deleted"];
	// The reload after the delete settles first...
	items = ["kept"];
	// ...then the request that left before the delete settles with its snapshot.
	items = ["kept", "deleted"];
	assert.deepEqual(items, ["kept", "deleted"], "this is the defect the gate prevents");
});

test("an older list response cannot repaint the list after a newer one settled", () => {
	const gate = createLatestRequestGate();
	let items = ["kept", "deleted"];

	const first = gate.begin(); // mount or poll read, leaves before the delete
	const second = gate.begin(); // reload after the delete

	if (gate.isCurrent(second)) items = ["kept"];
	assert.deepEqual(items, ["kept"]);

	if (gate.isCurrent(first)) items = ["kept", "deleted"];
	assert.deepEqual(items, ["kept"], "the pre-delete snapshot must not win");
});

test("the newest load wins even when three overlap", () => {
	const gate = createLatestRequestGate();
	const tokens = [gate.begin(), gate.begin(), gate.begin()];
	const applied = [];
	for (const index of [2, 0, 1]) {
		if (gate.isCurrent(tokens[index])) applied.push(index);
	}
	assert.deepEqual(applied, [2]);
});

test("a mutation that writes its own result retires reads already on the wire", () => {
	const gate = createLatestRequestGate();
	let notes = [];
	const inFlight = gate.begin(); // refresh started by an earlier change event

	// The user adds a note; the response carries the authoritative note list.
	notes = ["new note"];
	gate.invalidate();

	const snapshot = ["old note"];
	if (gate.isCurrent(inFlight)) notes = snapshot;
	assert.deepEqual(notes, ["new note"]);
});

test("a read that starts after the mutation still applies", () => {
	const gate = createLatestRequestGate();
	const retiring = gate.begin();
	gate.invalidate();
	assert.equal(gate.isCurrent(retiring), false);
	const fresh = gate.begin();
	assert.equal(gate.isCurrent(fresh), true);
	assert.equal(gate.isCurrent(retiring), false);
});

/** The gate only helps where it is wired in, so the proven screens must use it. */
const GUARDED_LOADS = [
	["src/app/(drive)/drive/page.tsx", "the listing reload after trash, rename, move and upload"],
	["src/app/(drive)/drive-share-dialog.tsx", "the share list read that a share change can overtake"],
	["src/app/(drive)/drive-nav.tsx", "the folder tree that a create or a page reload can overtake"],
	["src/components/settings/import-jobs.tsx", "the import-job poll that a cancel or dismiss can overtake"],
	["src/components/messages/conversation-notes-context.tsx", "the notes refresh that a note edit can overtake"],
];

for (const [file, what] of GUARDED_LOADS) {
	test(`${file} gates ${what}`, () => {
		const source = readFileSync(join(root, file), "utf8");
		assert.match(source, /useMemo\(\(\) => createLatestRequestGate\(\), \[\]\)/, `${file} must own a gate`);
		assert.match(source, /gate\.begin\(\)/, `${file} must open each load through the gate`);
		assert.match(source, /gate\.isCurrent\(/, `${file} must check the token before writing state`);
	});
}

for (const file of [
	"src/app/(drive)/drive-share-dialog.tsx",
	"src/components/messages/conversation-notes-context.tsx",
]) {
	test(`${file} retires in-flight reads when a mutation writes its own result`, () => {
		const source = readFileSync(join(root, file), "utf8");
		assert.match(source, /gate\.invalidate\(\)/, `${file} must invalidate after a mutation`);
	});
}
