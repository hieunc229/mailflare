import { invalidArguments } from "./errors";

/**
 * `ids`/`properties`-style `String[]` method args: anything else is a client
 * error (`invalidArguments`), not a server failure to log as `serverFail`.
 */
export function stringArrayArg(value: unknown, name: string): string[] | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalidArguments(`${name} must be an array of strings`);
	return value;
}
