import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLatestRequestGate } from "../src/lib/client/latest-request.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Sweep 25: the sites sweep 24 left AT-RISK, proved or dismissed one by one.
// Each block below models the exact ordering that was proved reachable — the
// read that leaves before the mutation settles last with its pre-mutation
// snapshot — and asserts the older write is dropped.

/* ---------------------------------------------------------------- promotions */

const workingOnPromotions = (backfill) => backfill?.status === "pending" || backfill?.status === "running";

test("ungated, a poll read puts back the mode the user just left", () => {
	// What the defect looked like before this sweep: the poll tick is armed only
	// while a sort is running, and its response carries the mode it read.
	const state = { mode: "off", backfill: { status: "done" } };
	Object.assign(state, { mode: "show", backfill: { status: "done" } });
	assert.equal(state.mode, "show", "this is the defect the gate prevents");
});

test("a poll read that left before the mode save cannot repaint the mode", () => {
	const gate = createLatestRequestGate();
	// The row still shows a running sort, so a poll tick is armed; the sort had
	// already finished on the server when that tick read the row.
	const state = { mode: "show", backfill: { status: "running" } };
	const pollToken = gate.begin(); // the tick leaves while the sort is displayed as running

	// The user turns promotions off; the PUT's own result is authoritative.
	state.mode = "off";
	state.backfill = { status: "done" };
	gate.invalidate();

	// The tick settles last, carrying the pre-save mode.
	if (gate.isCurrent(pollToken)) Object.assign(state, { mode: "show", backfill: { status: "done" } });

	assert.equal(state.mode, "off", "the saved mode must survive the poll response");
});

test("a stale `failed` poll read cannot cancel the sort the save just queued", () => {
	const gate = createLatestRequestGate();
	// The client still shows the sort running; on the server it has failed.
	const state = { mode: "show", backfill: { status: "running" } };
	assert.equal(workingOnPromotions(state.backfill), true, "the poll is armed because the sort looks active");

	const pollToken = gate.begin(); // settles with `failed`

	// Switching mode on a failed job requeues it (backfillPatchForModeChange), so the
	// PUT response carries a pending sort and must be what the poll follows.
	state.mode = "separate";
	state.backfill = { status: "pending" };
	gate.invalidate();

	if (gate.isCurrent(pollToken)) Object.assign(state, { mode: "show", backfill: { status: "failed" } });

	assert.equal(state.mode, "separate");
	assert.equal(state.backfill.status, "pending");
	assert.equal(workingOnPromotions(state.backfill), true, "the poll must keep following the queued sort");
});

test("a read for one mailbox does not retire another mailbox's read", () => {
	// The panel loads every mailbox at once, so the guard has to be per row: one
	// shared token would leave the other rows stuck on their loading skeleton.
	const gates = new Map();
	const gateFor = (id) => {
		let gate = gates.get(id);
		if (!gate) {
			gate = createLatestRequestGate();
			gates.set(id, gate);
		}
		return gate;
	};
	const first = gateFor("a").begin();
	const other = gateFor("b").begin();
	const second = gateFor("a").begin();
	assert.equal(gateFor("b").isCurrent(other), true, "mailbox b's read still applies");
	assert.equal(gateFor("a").isCurrent(first), false);
	assert.equal(gateFor("a").isCurrent(second), true);
});

/* ------------------------------------------------------------------ accounts */

test("the older accounts reload cannot drop the row the newer reload just added", () => {
	const gate = createLatestRequestGate();
	let rows = ["admin"];
	const createReload = gate.begin(); // reload after "create bob"
	const restoreReload = gate.begin(); // reload after "restore carol"
	if (gate.isCurrent(restoreReload)) rows = ["admin", "bob", "carol"];
	if (gate.isCurrent(createReload)) rows = ["admin", "bob"];
	assert.deepEqual(rows, ["admin", "bob", "carol"]);
});

test("a mount read that settles after a mutation reload cannot undo it", () => {
	const gate = createLatestRequestGate();
	let rows = ["admin"];
	const mountRead = gate.begin();
	const mutationReload = gate.begin();
	if (gate.isCurrent(mutationReload)) rows = ["admin", "restored"];
	if (gate.isCurrent(mountRead)) rows = ["admin"];
	assert.deepEqual(rows, ["admin", "restored"]);
});

/* ------------------------------------------------------------------ api keys */

test("a key read that settles after a create cannot hide the new key", () => {
	const gate = createLatestRequestGate();
	let keys = ["old"];
	const mountRead = gate.begin(); // still on the wire when the create commits

	keys = [...keys, "new"]; // the create writes its own reload's result
	gate.invalidate();

	const snapshot = ["old"];
	if (gate.isCurrent(mountRead)) keys = snapshot;
	assert.deepEqual(keys, ["old", "new"]);
});

test("a read in flight cannot bring a revoked key back", () => {
	const gate = createLatestRequestGate();
	let keys = ["a", "b"];
	const inFlight = gate.begin();

	keys = keys.filter((key) => key !== "b"); // revoke drops the row from the list it holds
	gate.invalidate();

	if (gate.isCurrent(inFlight)) keys = ["a", "b"];
	assert.deepEqual(keys, ["a"]);
});

/* ------------------------------------------------------------- drive folders */

test("a folder read that left before the page's event load cannot repaint the tree", () => {
	const gate = createLatestRequestGate();
	let tree = ["Old"];
	const beforeMutation = gate.begin(); // the read that left before the rename committed

	// The rename commits, the page's listing load resolves and dispatches
	// DRIVE_FOLDERS_EVENT, so the tree is read again.
	const fromEvent = gate.begin();
	if (gate.isCurrent(fromEvent)) tree = ["New"];

	// The pre-mutation read settles last.
	if (gate.isCurrent(beforeMutation)) tree = ["Old"];
	assert.deepEqual(tree, ["New"]);
});

test("inside that window the tree can only show what the server already had", () => {
	// Between the commit and the event there is no folder read that started after
	// the commit, so a settling pre-mutation read repaints the tree that is
	// already on screen: the window is one listing round trip of latency, not an
	// older snapshot replacing a newer one.
	const gate = createLatestRequestGate();
	let tree = ["Old"];
	const beforeMutation = gate.begin();
	if (gate.isCurrent(beforeMutation)) tree = ["Old"];
	const after = gate.begin();
	if (gate.isCurrent(after)) tree = ["New"];
	assert.deepEqual(tree, ["New"], "the newer read still wins once it lands");
});

/* ------------------------------------------------------------------- wiring */

/** The gate only helps where it is wired in, so the proved screens must use it. */
const GUARDED_LOADS = [
	["src/components/settings/promotions-settings.tsx", "the promotions poll that a mode save can overtake"],
	["src/app/(admin)/accounts/page.tsx", "the accounts reload that a second mutation's reload can overtake"],
	["src/components/settings/api-keys-settings.tsx", "the key list that a create or a revoke can overtake"],
	["src/app/(drive)/drive-nav.tsx", "the folder tree that a page reload can overtake"],
];

for (const [file, what] of GUARDED_LOADS) {
	test(`${file} gates ${what}`, () => {
		const source = readFileSync(join(root, file), "utf8");
		assert.match(source, /createLatestRequestGate\(\)/, `${file} must own a gate`);
		assert.match(source, /\.begin\(\)/, `${file} must open each load through the gate`);
		assert.match(source, /\.isCurrent\(/, `${file} must check the token before writing state`);
	});
}

for (const file of [
	"src/components/settings/promotions-settings.tsx",
	"src/components/settings/api-keys-settings.tsx",
]) {
	test(`${file} retires in-flight reads when a mutation writes its own result`, () => {
		const source = readFileSync(join(root, file), "utf8");
		assert.match(source, /\.invalidate\(\)/, `${file} must invalidate after a mutation`);
	});
}

test("the accounts mount read goes through the same gate as the mutation reloads", () => {
	const source = readFileSync(join(root, "src/app/(admin)/accounts/page.tsx"), "utf8");
	assert.equal((source.match(/accountsGate\.begin\(\)/g) ?? []).length, 2, "mount load and loadAccounts both begin a token");
});

test("every mailbox row gets its own promotions gate", () => {
	const source = readFileSync(join(root, "src/components/settings/promotions-settings.tsx"), "utf8");
	assert.match(source, /new Map<string, LatestRequestGate>\(\)/, "the panel must key its gates by mailbox");
});
