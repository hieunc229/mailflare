import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "rate-limit-eviction", entryPoint: "server/runtime/misc.ts", mocks: {} });
after(() => fixture.dispose());
const { openRateLimiter } = await fixture.import();

// The window map is private; capture it by watching which Map the limiter creates.
function openWithMap(limit, period) {
	const Original = globalThis.Map;
	let captured;
	globalThis.Map = class extends Original {
		constructor(...args) {
			super(...args);
			captured ??= this;
		}
	};
	try {
		return { limiter: openRateLimiter(limit, period), windows: captured };
	} finally {
		globalThis.Map = Original;
	}
}

test("expired windows are swept once the map is large, live windows are kept", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { limiter, windows } = openWithMap(2, 1);
	await limiter.limit({ key: "live" });
	await limiter.limit({ key: "live" });
	for (let i = 0; i < 6000; i++) await limiter.limit({ key: `k${i}` });
	t.mock.timers.tick(1500);
	await limiter.limit({ key: "live" });
	assert.ok(windows.size < 100, `expected expired windows to be swept, found ${windows.size}`);
	// "live" was refreshed above, and an unexpired window is still limited.
	await limiter.limit({ key: "live" });
	assert.equal((await limiter.limit({ key: "live" })).success, false);
	assert.equal((await limiter.limit({ key: "k0" })).success, true);
});

test("a large map is scanned at most once per window", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { limiter, windows } = openWithMap(2, 1);
	for (let i = 0; i < 6000; i++) await limiter.limit({ key: `k${i}` });
	let scans = 0;
	const iterate = windows[Symbol.iterator].bind(windows);
	windows[Symbol.iterator] = () => {
		scans += 1;
		return iterate();
	};
	for (let i = 0; i < 50; i++) await limiter.limit({ key: `more${i}` });
	assert.equal(scans, 0, "no scan inside the window that the last sweep started");
	t.mock.timers.tick(1500);
	await limiter.limit({ key: "later" });
	await limiter.limit({ key: "later" });
	assert.equal(scans, 1);
});
