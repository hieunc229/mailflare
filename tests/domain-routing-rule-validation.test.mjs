import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-routing-rule-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { domainRoutingRuleSchema } from "./src/lib/validators.ts";
			export { emptyRuleInput, ruleToInput } from "./src/components/settings/domain-routing/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "domain-routing-rule-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { domainRoutingRuleSchema, emptyRuleInput, ruleToInput } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// The rule dialog submits every field of its form state, whatever the action.
function dialogPayload(overrides) {
	return { ...emptyRuleInput("domain"), name: "Catch-all", matchValue: "*", ...overrides };
}

function fieldErrors(input) {
	const parsed = domainRoutingRuleSchema.safeParse(input);
	return parsed.success ? null : parsed.error.flatten().fieldErrors;
}

test("deliver and reject rules accept the blank forwarding address the dialog submits", () => {
	const deliver = dialogPayload({ action: "store", mailboxId: "mailbox" });
	assert.equal(deliver.forwardTo, "");
	assert.equal(fieldErrors(deliver), null);
	assert.equal(domainRoutingRuleSchema.parse(deliver).forwardTo, null);
	assert.equal(domainRoutingRuleSchema.parse({ ...deliver, forwardTo: "   " }).forwardTo, null);
	assert.equal(fieldErrors(dialogPayload({ action: "reject" })), null);
});

test("editing or toggling a stored deliver rule resubmits its forwarding address as blank", () => {
	const input = ruleToInput({
		id: "rule",
		domainId: "domain",
		name: null,
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: "*",
		action: "store",
		mailboxId: "mailbox",
		forwardTo: null,
		keepCopy: false,
		rejectReason: null,
		priority: 0,
		matchCount: 0,
		lastMatchedAt: null,
	});
	assert.equal(input.forwardTo, "");
	assert.equal(fieldErrors(input), null);
	assert.equal(fieldErrors({ ...input, enabled: false }), null);
});

test("forward rules still require a valid forwarding address", () => {
	assert.ok(fieldErrors(dialogPayload({ action: "forward" }))?.forwardTo?.includes("A forwarding destination is required"));
	assert.ok(fieldErrors(dialogPayload({ action: "forward", forwardTo: "not-an-address" }))?.forwardTo);
	const forward = dialogPayload({ action: "forward", forwardTo: " team@example.com " });
	assert.equal(fieldErrors(forward), null);
	assert.equal(domainRoutingRuleSchema.parse(forward).forwardTo, "team@example.com");
});

test("a domain rule cannot match on message content", () => {
	assert.ok(fieldErrors(dialogPayload({ action: "reject", matchField: "content", matchValue: "x" }))?.matchField?.includes("Domain rules cannot match on message content"));
	assert.equal(fieldErrors(dialogPayload({ action: "reject", matchField: "title", matchValue: "invoice" })), null);
});
