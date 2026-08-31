import { z } from "zod";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_VALUES } from "@/lib/folders/colors";

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

export const mailboxSchema = z.object({
	domainId: z.string().min(1),
	ownerUserId: z.string().min(1).optional(),
	localPart: z.string().min(1).max(64),
	displayName: z.string().optional(),
	type: z.enum(["personal", "shared"]).optional(),
});

export const updateManagedAccountSchema = z.object({
	name: z.string().trim().min(1).max(100),
	role: z.enum(["admin", "user"]),
	disabled: z.boolean(),
	canManageMailboxes: z.boolean(),
	forwardingEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).optional().transform((value) => value === undefined ? undefined : value || null),
	),
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

export const createUserAccountSchema = z.object({
	username: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._%+-]+$/),
	domainId: z.string().min(1),
	password: z.string().min(8).max(128),
	role: z.enum(["admin", "user"]).default("user"),
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
	signature: z.string().max(10_000).nullable().optional(),
	autoReplyEnabled: z.boolean().optional(),
	autoReplySubject: z.string().trim().max(200).optional(),
	autoReplyBody: z.string().max(10_000).optional(),
	useAllDomains: z.boolean().optional(),
});

export const folderSchema = z.object({
	mailboxId: z.string().min(1),
	name: z.string().trim().min(1).max(80),
	color: z.enum(FOLDER_COLOR_VALUES).default(DEFAULT_FOLDER_COLOR),
});

export const updateProfileSchema = z.object({
	name: z.string().trim().min(1).max(100),
	resetEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).transform((value) => value || null),
	),
	forwardingEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).optional().transform((value) => value === undefined ? undefined : value || null),
	),
});

export const updateForwardingEmailSchema = z.object({
	forwardingEmail: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().email().or(z.literal("")).transform((value) => value || null),
	),
});

export const updateBarkSettingsSchema = z.object({
	barkUrl: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().max(2048).or(z.literal("")).transform((value) => value || ""),
	),
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1),
	newPassword: z.string().min(8).max(128),
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
