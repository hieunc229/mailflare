import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

function splitSql(sql) {
	const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|;|[^\S\n]+|\n|./g) ?? [];
	const statements = [];
	let current = "";
	let triggerDepth = 0;
	let insideTrigger = false;

	for (const token of tokens) {
		if (token.startsWith("--") || token.startsWith("/*")) {
			current += " ";
			continue;
		}

		const word = token.toUpperCase();
		if (word === "TRIGGER") insideTrigger = true;
		if (insideTrigger && (word === "BEGIN" || word === "CASE")) triggerDepth += 1;
		if (insideTrigger && word === "END") triggerDepth -= 1;
		current += token;

		if (token === ";" && triggerDepth === 0) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			insideTrigger = false;
		}
	}

	if (current.trim()) statements.push(current.trim());
	return statements;
}

function readMigrations(directory, split) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		// A Windows checkout (core.autocrlf) has CRLF files; the bundle stays LF either way.
		.map((name) => ({ name, statements: split(readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n")) }));
}

// PostgreSQL function bodies and MySQL trigger bodies contain semicolons, so those migrations are split only
// on the explicit breakpoint markers drizzle-kit writes (and the hand-written files copy).
function splitOnBreakpoints(sql) {
	return sql
		.split(/-->\s*statement-breakpoint/g)
		.map((statement) => statement.replace(/^\s*--[^\n]*$/gm, "").trim())
		.filter(Boolean);
}

const bundles = [
	{ file: "bundle.json", directory: "drizzle/migrations/", split: splitSql },
	{ file: "bundle-postgres.json", directory: "drizzle/migrations-pg/", split: splitOnBreakpoints },
	{ file: "bundle-mysql.json", directory: "drizzle/migrations-mysql/", split: splitOnBreakpoints },
];

for (const { file, directory, split } of bundles) {
	const migrations = readMigrations(new URL(directory, root), split);
	writeFileSync(new URL(`src/lib/migrations/${file}`, root), `${JSON.stringify({ migrations }, null, 2)}\n`);
}
