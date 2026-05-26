import { z } from "zod";

export const sendEmailSchema = z.object({
	from: z.string().min(3),
	to: z.string().min(3),
	subject: z.string().min(1).max(500),
	html: z.string().optional(),
	text: z.string().optional(),
	mailboxId: z.string().optional(),
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
	localPart: z.string().min(1).max(64),
	displayName: z.string().optional(),
});

export const routingRuleSchema = z.object({
	domainId: z.string().min(1),
	pattern: z.string().min(1),
	action: z.enum(["store", "forward", "reject"]),
	mailboxId: z.string().optional(),
	forwardTo: z.string().email().optional(),
	priority: z.number().int().default(0),
});

export const webhookSchema = z.object({
	url: z.string().url(),
	events: z.array(z.string()).min(1),
});
