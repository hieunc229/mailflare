import assert from "node:assert/strict";

const best = (run, input, reps) => {
	let ms = Infinity;
	for (let i = 0; i < 3; i++) {
		const started = performance.now();
		for (let j = 0; j < reps; j++) run(input);
		ms = Math.min(ms, performance.now() - started);
	}
	return ms;
};

// make(n) builds an input of size n; run(input) is the code under test.
// Linear code grows about 4x for 4n; quadratic code grows about 16x, so a ratio under 6 tells them apart.
// reps repeats run inside each timed sample so that fast code still takes about 20 ms.
// For work that must not follow a value at all, pass a larger factor: constant time stays under the same ratio.
export function assertLinear(make, run, n, label = "", factor = 4, reps = 1) {
	const small = best(run, make(n), reps);
	const large = best(run, make(factor * n), reps);
	assert.ok(large < 10_000, `${label} hang guard: ${large} ms`);
	assert.ok(large < 6 * Math.max(small, 1), `${label} grew ${(large / small).toFixed(1)}x for ${factor}x input (${small.toFixed(1)} -> ${large.toFixed(1)} ms)`);
}
