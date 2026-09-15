import { z } from "zod";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLOR_VALUES } from "@/lib/folders/colors";

/**
 * Recipients arrive either as one comma-separated header string (the composer)
 * or as an array (the public API). Both normalise to a trimmed list of entries
 * that still carry their display names.
 */
const recipientListSchema = z
	.union([z.string().max(5000), z.array(z.string().trim().min(3).max(500)).max(50)])
	.transform((value) => (Array.isArray(value) ? value : splitEmailAddressList(value)))
	.refine((list) => list.length <= 50, "A message can have at most 50 recipients per field")
	.refine((list) => list.every((entry) => getEmailAddress(entry).includes("@")), "Enter valid email addresses");

const messageIdListSchema = z
	.union([z.string().max(5000), z.array(z.string().max(998)).max(50)])
	.transform((value) => (Array.isArray(value) ? value.join(" ") : value));

export const sendEmailSchema = z.object({
	from: z.string().min(3).max(500),
	to: recipientListSchema.refine((list) => list.length > 0, "At least one recipient is required"),
	cc: recipientListSchema.optional(),
	bcc: recipientListSchema.optional(),
	subject: z.string().min(1).max(500),
	inReplyTo: z.string().max(998).optional(),
	references: messageIdListSchema.optional(),
	threadId: z.string().max(998).optional(),
	html: z.string().max(2 * 1024 * 1024).optional(),
	text: z.string().max(2 * 1024 * 1024).optional(),
	mailboxId: z.string().min(1).max(200),
	scheduledAt: z.string().datetime().optional(),
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
	enableSending: z.boolean().optional(),
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

export const passwordResetRequestSchema = z.object({
	email: z.string().trim().email(),
});

export const passwordResetConfirmSchema = z.object({
	token: z.string().min(8).max(200),
	password: z.string().min(8).max(128),
});

export const mfaVerifySchema = z.object({
	challengeToken: z.string().min(8).max(200),
	code: z.string().trim().min(6).max(32),
});

export const mfaEnrollSchema = z.object({
	password: z.string().min(1),
});

export const mfaConfirmSchema = z.object({
	code: z.string().trim().min(6).max(12),
});

export const mfaDisableSchema = z.object({
	password: z.string().min(1),
	code: z.string().trim().min(6).max(32),
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
	/** Set a new password for the account; every session of that user is revoked. */
	password: z.preprocess(
		(value) => (typeof value === "string" ? value.trim() : value),
		z.string().min(8).max(128).or(z.literal("")).optional().transform((value) => value || null),
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

export const createMailboxAliasSchema = z.object({
	domainId: z.string().min(1),
	localPart: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9._%+-]+$/)
		.transform((value) => value.toLowerCase()),
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

export const updateShortcutsSettingsSchema = z.object({
	enabled: z.boolean(),
});

export const updateSpamSettingsSchema = z.object({
	enabled: z.boolean(),
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

export const domainRoutingRuleSchema = z
	.object({
		domainId: z.string().min(1),
		name: z.string().trim().max(120).optional(),
		enabled: z.boolean().default(true),
		matchField: z.enum(["recipient", "sender", "title", "content"]).default("recipient"),
		matchOperator: z.enum(["contains", "exact", "starts_with", "ends_with", "regex"]).default("contains"),
		matchValue: z.string().trim().min(1).max(500),
		action: z.enum(["store", "forward", "reject"]),
		mailboxId: z.string().min(1).nullish(),
		forwardTo: z.string().trim().email().nullish(),
		keepCopy: z.boolean().default(false),
		rejectReason: z.string().trim().max(200).nullish(),
		priority: z.number().int().min(0).max(1000).default(0),
	})
	.superRefine((value, ctx) => {
		if (value.action === "store" && !value.mailboxId) {
			ctx.addIssue({
				code: "custom",
				path: ["mailboxId"],
				message: "Choose the mailbox that should receive matching mail",
			});
		}
		if (value.action === "forward" && !value.forwardTo) {
			ctx.addIssue({
				code: "custom",
				path: ["forwardTo"],
				message: "A forwarding destination is required",
			});
		}
		if (value.action === "forward" && value.keepCopy && !value.mailboxId) {
			ctx.addIssue({
				code: "custom",
				path: ["mailboxId"],
				message: "Keeping a copy requires a destination mailbox",
			});
		}
		if (value.matchOperator === "regex") {
			try {
				new RegExp(value.matchValue);
			} catch {
				ctx.addIssue({
					code: "custom",
					path: ["matchValue"],
					message: "Enter a valid regular expression",
				});
			}
		}
	});

export const webhookSchema = z.object({
	url: z.string().url().max(2048),
	description: z.string().trim().max(200).optional(),
	events: z
		.array(z.enum(["message.inbound", "message.outbound", "message.failed"]))
		.min(1)
		.max(3),
	maxAttempts: z.number().int().min(1).max(10).default(5),
});

export const webhookUpdateSchema = z.object({
	url: z.string().url().max(2048).optional(),
	description: z.string().trim().max(200).nullish(),
	events: z
		.array(z.enum(["message.inbound", "message.outbound", "message.failed"]))
		.min(1)
		.max(3)
		.optional(),
	enabled: z.boolean().optional(),
	maxAttempts: z.number().int().min(1).max(10).optional(),
});

export const deviceRegisterSchema = z.object({
	token: z.string().min(1).max(500),
	platform: z.enum(["ios", "android", "web"]),
});

export const deviceRevokeSchema = z.object({
	token: z.string().min(1).max(500),
});
