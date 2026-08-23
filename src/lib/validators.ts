import { z } from "zod";

export const sendEmailSchema = z.object({
	from: z.string().min(3).max(500),
	to: z.string().min(3).max(500),
	subject: z.string().min(1).max(500),
	html: z.string().max(2 * 1024 * 1024).optional(),
	text: z.string().max(2 * 1024 * 1024).optional(),
	mailboxId: z.string().min(1).max(200),
	attachments: z
		.array(
			z.object({
					filename: z.string().min(1).max(255),
					type: z.string().min(1).max(255).default("application/octet-stream"),
					contentBase64: z.string().min(1).max(14 * 1024 * 1024),
			}),
		)
		.max(10)
		.optional(),
});

export const registerSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	name: z.string().min(1),
});

export const firstRunRegisterSchema = z.object({
	domain: z.string().min(3),
	username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._%+-]+$/),
	password: z.string().min(8),
	resetEmail: z.string().email(),
});

export const primaryDomainRegisterSchema = z.object({
	username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._%+-]+$/),
	password: z.string().min(8),
	resetEmail: z.string().email(),
});

export const setupDomainSchema = z.object({
	hostname: z.string().min(3),
});

export const addDomainSchema = z.object({
	hostname: z.string().min(3),
	enableRouting: z.boolean().optional(),
	enableSending: z.boolean().optional(),
});

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

export const domainSchema = z.object({
	hostname: z.string().min(3),
});

const forwardToSchema = z.preprocess(
	(value) => (typeof value === "string" ? value.trim() : value),
	z.string().email().or(z.literal("")).optional().transform((value) => value || null),
);

export const mailboxSchema = z.object({
	domainId: z.string().min(1),
	localPart: z.string().min(1).max(64),
	displayName: z.string().optional(),
	type: z.enum(["personal", "shared"]).optional(),
	forwardTo: forwardToSchema,
});

export const createAccountSchema = z.object({
	domainId: z.string().min(1),
	username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._%+-]+$/),
	password: z.string().min(8),
	name: z.string().trim().min(1).max(100).optional(),
	resetEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).optional().transform((value) => value || null),
	),
});

export const updateAccountSchema = z.object({
	email: z.string().email().optional(),
	name: z.string().trim().min(1).max(100),
	disabled: z.boolean().optional(),
	password: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().min(8).or(z.literal("")).optional().transform((value) => value || null),
	),
});

export const mailboxAccessSchema = z.object({
	userId: z.string().min(1),
	permission: z.enum(["read_only", "send_as", "send_on_behalf", "full_access"]),
});

export const accountMailboxAccessSchema = z.object({
	mailboxId: z.string().min(1),
	permission: z.enum(["read_only", "send_as", "send_on_behalf", "full_access"]),
});

export const accountMailboxSchema = z.object({
	domainId: z.string().min(1),
	localPart: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._%+-]+$/),
	displayName: z.string().trim().max(100).optional(),
});

export const updateMailboxSchema = z.object({
	displayName: z.string().max(100).nullable().optional(),
	// No preprocess/transform here (unlike forwardToSchema above): PATCH must
	// distinguish "key omitted" (leave forwardTo untouched) from "explicitly
	// cleared" (empty string/null), so the field's presence in parsed.data
	// has to mirror its presence in the request body.
	forwardTo: z.string().trim().email().or(z.literal("")).nullable().optional(),
});

export const folderSchema = z.object({
	mailboxId: z.string().min(1),
	name: z.string().trim().min(1).max(80),
});

export const updateProfileSchema = z.object({
	name: z.string().trim().min(1).max(100),
	resetEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).transform((value) => value || null),
	),
});

export const routingRuleSchema = z.object({
	domainId: z.string().optional(),
	pattern: z.string().trim().min(1).max(200).optional(),
	matchField: z.enum(["email", "content", "title"]).default("email"),
	matchOperator: z.enum(["contains", "exact"]).default("contains"),
	matchValue: z.string().trim().min(1).max(500),
	action: z.enum(["store", "forward", "reject", "spam", "trash"]).optional(),
	mailboxId: z.string().min(1),
	folderId: z.string().optional(),
	destination: z.string().min(1).optional(),
	forwardTo: z.string().email().optional(),
	priority: z.number().int().default(0),
});

export const webhookSchema = z.object({
	url: z.string().url().max(2048),
	events: z
		.array(z.enum(["message.inbound", "message.outbound", "message.failed"]))
		.min(1)
		.max(3),
});
