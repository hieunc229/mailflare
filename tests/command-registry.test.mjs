import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const provider = readFileSync(join(root, "src/components/shortcuts/shortcuts-context.tsx"), "utf8");
const catalogs = ["src/lib/i18n/en.json", ...readdirSync(join(root, "public/locales")).filter((file) => file.endsWith(".json")).map((file) => `public/locales/${file}`)];

const expected = [
	{ id: "nav-calendar", key: "commandPalette.calendar", path: "/calendar", route: "src/app/(calendar)/calendar/page.tsx" },
	{ id: "nav-contacts", key: "commandPalette.contacts", path: "/contacts", route: "src/app/(dashboard)/contacts/page.tsx" },
	{ id: "nav-drive", key: "commandPalette.drive", path: "/drive", route: "src/app/(drive)/drive/page.tsx" },
];

test("command palette has Calendar, Contacts and Drive navigation entries with real targets", () => {
	const positions = expected.map(({ id }) => provider.indexOf(`id: "${id}"`));
	assert.ok(positions.every((position) => position >= 0), "all navigation entries are registered");
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "navigation commands preserve registry order");
	for (const command of expected) {
		const entry = provider.match(new RegExp(`id: "${command.id}"[\\s\\S]*?\\n      },`))?.[0];
		assert.ok(entry, `missing palette command ${command.id}`);
		assert.ok(entry.includes(`title: t("${command.key}")`), `${command.id} uses the expected translation key`);
		assert.ok(entry.includes(`router.push("${command.path}")`), `${command.id} uses its route target`);
		assert.ok(existsSync(join(root, command.route)), `route does not exist: ${command.path}`);
	}
});

test("focus-search command defers its lookup and focus until after the palette closes", () => {
	const entry = provider.match(/id: "focus-search"[\s\S]*?\n      },/)?.[0];
	assert.ok(entry, "missing focus-search palette command");
	assert.ok(entry.includes('title: t("commandPalette.focusSearch")'));
	assert.ok(entry.includes('document.querySelector<HTMLInputElement>(\'input[data-mail-search-input]\')'));
	assert.ok(entry.includes("setTimeout(() =>"));
	assert.ok(entry.includes("searchInput.focus()"));
	assert.ok(entry.includes("searchInput.select()"));

	const callback = entry.match(/perform: (\(\) => \{[\s\S]*?\n        \}),/)?.[1];
	assert.ok(callback, "could not extract focus-search perform callback");
	const perform = new Function(`return ${callback.replaceAll("document.querySelector<HTMLInputElement>", "document.querySelector")}`)();
	const focusCalls = [];
	const input = { focus: () => focusCalls.push("focus"), select: () => focusCalls.push("select") };
	let currentInput = input;
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const originalSetTimeout = globalThis.setTimeout;
	let scheduled;
	try {
		Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => currentInput } });
		globalThis.setTimeout = (callback) => { scheduled = callback; return 1; };
		perform();
		assert.deepEqual(focusCalls, [], "focus must wait for the dismiss/unmount commit");
		assert.equal(typeof scheduled, "function");
		scheduled();
		assert.deepEqual(focusCalls, ["focus", "select"]);
		currentInput = null;
		perform();
		scheduled();
		assert.deepEqual(focusCalls, ["focus", "select"], "a field removed before the deferred lookup is safely ignored");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
		else delete globalThis.document;
	}
});

test("all palette command labels are present in every locale catalog", () => {
	for (const file of catalogs) {
		const catalog = JSON.parse(readFileSync(join(root, file), "utf8"));
		for (const command of [...expected, { key: "commandPalette.focusSearch" }]) {
			assert.equal(typeof catalog[command.key], "string", `${file} is missing ${command.key}`);
		}
	}
	assert.equal(catalogs.length, 34);
});
