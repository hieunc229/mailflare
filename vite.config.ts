import { defineConfig, lazyPlugins } from "vite-plus";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import lintConfig from "./lint.config";

export default defineConfig({
	// Keep the existing source formatting while adopting Vite+ checks.
	check: { fmt: false },
	lint: { ...lintConfig, options: { typeAware: true, typeCheck: true } },
	resolve: {
		// css-tree's ESM build loads ../data/patch.json through createRequire, which workerd cannot resolve; the dist bundle inlines it.
		alias: [{ find: /^css-tree$/, replacement: "css-tree/dist/csstree.esm" }],
	},
	server: { allowedHosts: ["mailflare.local", "mail.dev", ...(process.env.MAILFLARE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [])] },
	plugins: lazyPlugins(() => [
		vinext({ images: { optimizer: imagesOptimizer() } }),
		cloudflare({
			// Browser tests can use disposable storage without resetting the local demo database.
			// A multi-tenant deployment (mailflare-cloud) builds this app with its own wrangler config.
			configPath: process.env.MAILFLARE_WRANGLER_CONFIG,
			persistState: process.env.MAILFLARE_TEST_STATE_PATH ? { path: process.env.MAILFLARE_TEST_STATE_PATH } : true,
			remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === "true",
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
		}),
	]),
});
