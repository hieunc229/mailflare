import { build } from "esbuild";

// Bundle the self-hosted entrypoint (server/index.ts) and the app modules it
// pulls in. Next, native modules and network libraries stay external and are
// resolved from node_modules at runtime.
await build({
	entryPoints: ["server/index.ts"],
	outfile: "dist/server.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: true,
	tsconfig: "tsconfig.json",
	external: ["next", "better-sqlite3", "nodemailer", "smtp-server", "ws", "react", "react-dom", "@opennextjs/cloudflare", "cloudflare:workers"],
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
	logLevel: "info",
});
