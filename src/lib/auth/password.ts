import bcrypt from "bcryptjs";

export function hashPassword(password: string): string {
	return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
	return bcrypt.compareSync(password, hash);
}
