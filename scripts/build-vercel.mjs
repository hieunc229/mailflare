#!/usr/bin/env node
/**
 * `next build` for Vercel (`npm run build:vercel`). It adds the one Pages Router route that carries CalDAV and
 * CardDAV for the duration of the build; the compiled route stays in `.next`, the source file is removed again.
 * See server/runtime/vercel-dav-page.ts for why it is not part of the source tree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = join(root, "src", "pages");
const route = join(pages, "api", "internal", "dav.ts");
// Next reads `config` from the route file itself, so it cannot be re-exported with the handler.
const source = `// Written by scripts/build-vercel.mjs. Do not edit or commit.
export { default } from "../../../../server/runtime/vercel-dav-page";

export const config = { api: { bodyParser: false, externalResolver: true } };
`;

const createdPages = !existsSync(pages);
// Next rewrites its type files for a project with a Pages Router, which would break a later `tsc` here.
const nextEnv = join(root, "next-env.d.ts");
const previousNextEnv = existsSync(nextEnv) ? readFileSync(nextEnv) : null;
mkdirSync(dirname(route), { recursive: true });
writeFileSync(route, source);

let status = 1;
try {
	const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
	const result = spawnSync(process.execPath, [next, "build"], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, MAILFLARE_RUNTIME: "vercel" },
	});
	status = result.status ?? 1;
} finally {
	rmSync(createdPages ? pages : route, { recursive: true, force: true });
	rmSync(join(root, ".next", "types"), { recursive: true, force: true });
	if (previousNextEnv) writeFileSync(nextEnv, previousNextEnv);
	else rmSync(nextEnv, { force: true });
}
process.exit(status);
