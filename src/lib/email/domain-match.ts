/**
 * Conservative same-owner check: equal domains, or one is a subdomain of the
 * other. It deliberately does not collapse unrelated names under a shared
 * two-label suffix (`victim.co.ke` and `attacker.co.ke`), because those are
 * independent registrations even though the final labels match. Two sibling
 * subdomains are treated as different, which can add a warning but never hides
 * one.
 */
export function isSameOrSubdomain(a: string, b: string): boolean {
	const left = a.trim().toLowerCase().replace(/\.$/, "");
	const right = b.trim().toLowerCase().replace(/\.$/, "");
	if (!left || !right) return false;
	return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}
