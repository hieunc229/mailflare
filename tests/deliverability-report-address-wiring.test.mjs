import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("every path that creates a mailbox or alias refuses the reserved report local part", () => {
	for (const file of ["src/app/api/mailboxes/route.ts", "src/app/api/v1/mailboxes/utils.ts", "src/app/api/mailboxes/[id]/aliases/route.ts", "src/app/api/accounts/create.ts", "src/app/api/mailboxes/utils.ts"]) {
		assert.match(read(file), /isReportAddressReserved\(/, file);
	}
});
