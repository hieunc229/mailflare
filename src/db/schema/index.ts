import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	resetEmail: text("reset_email"),
	forwardingEmail: text("forwarding_email"),
	passwordHash: text("password_hash").notNull(),
	name: text("name").notNull(),
	bookingUsername: text("booking_username"),
	timeZone: text("time_zone"),
	avatarKey: text("avatar_key"),
	role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
	// Exactly one account is the primary admin: the one created during setup.
	// They own administrator management and can hand the role to another account.
	isPrimaryAdmin: integer("is_primary_admin", { mode: "boolean" }).notNull().default(false),
	disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
	canManageMailboxes: integer("can_manage_mailboxes", { mode: "boolean" }).notNull().default(false),
	// Capabilities the primary admin grants to other admins.
	canManageDomains: integer("can_manage_domains", { mode: "boolean" }).notNull().default(false),
	canManageUsers: integer("can_manage_users", { mode: "boolean" }).notNull().default(false),
	keyboardShortcutsEnabled: integer("keyboard_shortcuts_enabled", { mode: "boolean" }).notNull().default(true),
	spamProtectionEnabled: integer("spam_protection_enabled", { mode: "boolean" }).notNull().default(true),
	/** Days a message may stay in Trash or Spam before the scheduled purge deletes it; null keeps it forever. */
	trashRetentionDays: integer("trash_retention_days"),
	// Off shows the mailbox only. On shows Name <mailbox> on To, Cc, and Bcc.
	showFullRecipientAddresses: integer("show_full_recipient_addresses", { mode: "boolean" }).notNull().default(false),
	// TOTP second factor. The secret is written at enrolment and only counts
	// once the user has proven a code from their authenticator.
	totpSecret: text("totp_secret"),
	totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
	totpConfirmedAt: integer("totp_confirmed_at", { mode: "timestamp" }),
	createdByUserId: text("created_by_user_id").references((): AnySQLiteColumn => users.id, { onDelete: "set null" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("users_booking_username_idx").on(t.bookingUsername)]);

export const domains = sqliteTable(
	"domains",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		zoneId: text("zone_id").notNull(),
		status: text("status", { enum: ["pending", "active", "error"] })
			.notNull()
			.default("pending"),
		routingStatus: text("routing_status"),
		sendingSubdomainTag: text("sending_subdomain_tag"),
		sendingProvider: text("sending_provider", { enum: ["none", "cloudflare", "resend", "ses"] }).notNull().default("none"),
		receivingProvider: text("receiving_provider", { enum: ["none", "cloudflare", "resend", "ses"] }).notNull().default("cloudflare"),
		sendingRequested: integer("sending_requested", { mode: "boolean" }).notNull().default(false),
		sendingEnabled: integer("sending_enabled", { mode: "boolean" }).notNull().default(false),
		routingEnabled: integer("routing_enabled", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("domains_hostname_idx").on(t.hostname),
		index("domains_user_idx").on(t.userId),
	],
);

export const mailboxes = sqliteTable(
	"mailboxes",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		localPart: text("local_part").notNull(),
		displayName: text("display_name"),
		signature: text("signature"),
		autoReplyEnabled: integer("auto_reply_enabled", { mode: "boolean" }).notNull().default(false),
		autoReplySubject: text("auto_reply_subject").notNull().default("Out of office"),
		autoReplyBody: text("auto_reply_body").notNull().default(""),
		avatarKey: text("avatar_key"),
		type: text("type", { enum: ["personal", "shared"] }).notNull().default("personal"),
		useAllDomains: integer("use_all_domains", { mode: "boolean" }).notNull().default(true),
		disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("mailboxes_address_idx").on(t.domainId, t.localPart), index("mailboxes_user_idx").on(t.userId)],
);

export const mailboxAliases = sqliteTable(
	"mailbox_aliases",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		localPart: text("local_part").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("mailbox_aliases_address_idx").on(t.domainId, t.localPart),
		index("mailbox_aliases_mailbox_idx").on(t.mailboxId),
	],
);

export const autoReplyDeliveries = sqliteTable(
	"auto_reply_deliveries",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		recipient: text("recipient").notNull(),
		sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
	},
	(t) => [
		uniqueIndex("auto_reply_deliveries_mailbox_recipient_idx").on(t.mailboxId, t.recipient),
		index("auto_reply_deliveries_sent_idx").on(t.sentAt),
	],
);

export const mailboxAccess = sqliteTable(
	"mailbox_access",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		permission: text("permission", { enum: ["read_only", "send_as", "send_on_behalf", "full_access"] })
			.notNull()
			.default("read_only"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("mailbox_access_mailbox_user_idx").on(t.mailboxId, t.userId),
		index("mailbox_access_user_idx").on(t.userId),
		index("mailbox_access_mailbox_idx").on(t.mailboxId),
	],
);

export const contacts = sqliteTable(
	"contacts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		displayName: text("display_name"),
		avatarKey: text("avatar_key"),
		source: text("source", { enum: ["manual", "inbound", "outbound"] })
			.notNull()
			.default("inbound"),
		blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("contacts_user_email_idx").on(t.userId, t.email),
		index("contacts_user_idx").on(t.userId),
	],
);

export const folders = sqliteTable(
	"folders",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color").notNull().default("#2563eb"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("folders_mailbox_name_idx").on(t.mailboxId, t.name),
		index("folders_user_idx").on(t.userId),
		index("folders_mailbox_idx").on(t.mailboxId),
	],
);

export const jmapMailboxRevisions = sqliteTable("jmap_mailbox_revisions", {
	mailboxId: text("mailbox_id").primaryKey(),
	revision: integer("revision").notNull().default(0),
});

export const apiKeys = sqliteTable("api_keys", {
	id: text("id").primaryKey(),
	kind: text("kind", { enum: ["legacy", "mcp"] }).notNull().default("legacy"),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	prefix: text("prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	scopes: text("scopes").notNull(),
	mailboxScopeEnabled: integer("mailbox_scope_enabled", { mode: "boolean" }).notNull().default(false),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
		providerMessageId: text("provider_message_id"),
		folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
		fromAddr: text("from_addr").notNull(),
		toAddr: text("to_addr").notNull(),
		ccAddr: text("cc_addr"),
		bccAddr: text("bcc_addr"),
		subject: text("subject"),
		snippet: text("snippet"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),
		rawR2Key: text("raw_r2_key"),
		status: text("status").notNull().default("received"),
		read: integer("read", { mode: "boolean" }).notNull().default(false),
		starred: integer("starred", { mode: "boolean" }).notNull().default(false),
		snoozedUntil: integer("snoozed_until", { mode: "timestamp" }),
		threadId: text("thread_id"),
		// RFC 5322 threading headers, kept so replies land in the right conversation
		// and so outgoing replies can carry them on to the recipient's client.
		inReplyTo: text("in_reply_to"),
		references: text("references_header"),
		spamScore: integer("spam_score"),
		spamVerdict: text("spam_verdict", { enum: ["inbox", "suspicious", "spam"] }),
		spamSignals: text("spam_signals"),
		spamAnalyzedAt: integer("spam_analyzed_at", { mode: "timestamp" }),
		spamAnalysisError: text("spam_analysis_error"),
		/** When the message last entered Trash or Spam; maintained by triggers (migration 0053). */
		trashedAt: integer("trashed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("messages_user_created_idx").on(t.userId, t.createdAt),
		index("messages_mailbox_idx").on(t.mailboxId),
		index("messages_folder_idx").on(t.folderId),
		index("messages_thread_idx").on(t.mailboxId, t.threadId),
		index("messages_provider_message_idx").on(t.mailboxId, t.providerMessageId),
		index("messages_raw_r2_key_idx").on(t.rawR2Key),
		index("messages_trashed_at_idx").on(t.trashedAt),
		index("messages_inbox_page_idx").on(
			t.mailboxId,
			t.status,
			t.folderId,
			sql`${t.createdAt} desc`,
			sql`${t.id} desc`,
		),
		index("messages_thread_key_idx").on(
			t.mailboxId,
			t.status,
			t.folderId,
			sql`coalesce(${t.threadId}, ${t.id})`,
			t.createdAt,
		),
		index("messages_mailbox_thread_key_idx").on(t.mailboxId, sql`coalesce(${t.threadId}, ${t.id})`),
	],
);

export const spamTokenStats = sqliteTable(
	"spam_token_stats",
	{
		mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
		token: text("token").notNull(),
		spamCount: integer("spam_count").notNull().default(0),
		hamCount: integer("ham_count").notNull().default(0),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("spam_token_stats_mailbox_token_idx").on(t.mailboxId, t.token),
		index("spam_token_stats_mailbox_idx").on(t.mailboxId),
	],
);

export const spamReputation = sqliteTable(
	"spam_reputation",
	{
		mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
		type: text("type", { enum: ["email", "domain", "fingerprint"] }).notNull(),
		key: text("key").notNull(),
		messagesSeen: integer("messages_seen").notNull().default(0),
		spamCount: integer("spam_count").notNull().default(0),
		hamCount: integer("ham_count").notNull().default(0),
		firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("spam_reputation_mailbox_type_key_idx").on(t.mailboxId, t.type, t.key),
		index("spam_reputation_mailbox_idx").on(t.mailboxId),
	],
);

export const spamFeedback = sqliteTable(
	"spam_feedback",
	{
		messageId: text("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		classification: text("classification", { enum: ["spam", "ham"] }).notNull(),
		trainingTokens: text("training_tokens").notNull(),
		reputationKeys: text("reputation_keys").notNull(),
		tokenizerVersion: integer("tokenizer_version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("spam_feedback_mailbox_idx").on(t.mailboxId)],
);

export const messageAttachments = sqliteTable(
	"message_attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),
		disposition: text("disposition", { enum: ["attachment", "inline"] })
			.notNull()
			.default("attachment"),
		contentId: text("content_id"),
		r2Key: text("r2_key").notNull().unique(),
		/** Set when the attachment is moved to the Drive trash; hidden from the email until restored, purged after 30 days. */
		trashedAt: integer("trashed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("message_attachments_message_idx").on(t.messageId)],
);

export const sharedAttachmentLinks = sqliteTable("shared_attachment_links", {
	id: text("id").primaryKey(),
	attachmentId: text("attachment_id").notNull().references(() => messageAttachments.id, { onDelete: "cascade" }).unique(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const outboundJobs = sqliteTable("outbound_jobs", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
	status: text("status", { enum: ["queued", "sending", "sent", "failed"] }).notNull().default("queued"),
	payload: text("payload").notNull(),
	error: text("error"),
	scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const emailTemplates = sqliteTable(
	"email_templates",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		subject: text("subject").notNull().default(""),
		textBody: text("text_body").notNull().default(""),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("email_templates_user_idx").on(t.userId)],
);

export const calendarEvents = sqliteTable(
	"calendar_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		location: text("location").notNull().default(""),
		attendees: text("attendees").notNull().default("[]"),
		color: text("color").notNull().default("blue"),
		repeat: text("repeat", { enum: ["none", "daily", "weekly", "monthly", "weekdays"] }).notNull().default("none"),
		repeatDays: text("repeat_days").notNull().default("[]"),
		repeatAnchorDay: integer("repeat_anchor_day"),
		repeatUntil: integer("repeat_until", { mode: "timestamp" }),
		excludedOccurrences: text("excluded_occurrences").notNull().default("[]"),
		timeZone: text("time_zone"),
		startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
		endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("calendar_events_user_starts_idx").on(t.userId, t.startsAt)],
);

export const bookingEvents = sqliteTable(
	"booking_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull().default(""),
		description: text("description").notNull().default(""),
		color: text("color").notNull().default("#2563eb"),
		hostIds: text("host_ids").notNull().default("[]"),
		durationMinutes: integer("duration_minutes").notNull(),
		location: text("location").notNull().default(""),
		weekdays: text("weekdays").notNull().default("[1,2,3,4,5]"),
		startTime: text("start_time").notNull().default("09:00"),
		endTime: text("end_time").notNull().default("17:00"),
		timeRanges: text("time_ranges").notNull().default('[{"startTime":"09:00","endTime":"17:00"}]'),
		timeZone: text("time_zone").notNull().default("UTC"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("booking_events_user_idx").on(t.userId), uniqueIndex("booking_events_user_slug_idx").on(t.userId, t.slug)],
);

export const routingRules = sqliteTable(
	"routing_rules",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		// "mailbox" rules run after delivery and file the message into a folder or system status.
		// "domain" rules run during address resolution and can catch-all, forward, or reject.
		scope: text("scope", { enum: ["mailbox", "domain"] }).notNull().default("mailbox"),
		name: text("name"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		pattern: text("pattern").notNull(),
		matchField: text("match_field", {
			enum: ["email", "content", "title", "sender", "recipient"],
		})
			.notNull()
			.default("email"),
		matchOperator: text("match_operator", {
			enum: ["contains", "exact", "starts_with", "ends_with", "regex"],
		})
			.notNull()
			.default("contains"),
		matchValue: text("match_value").notNull().default(""),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
		action: text("action", { enum: ["store", "forward", "reject", "spam", "trash"] }).notNull().default("store"),
		forwardTo: text("forward_to"),
		// Forward actions drop the message by default; keepCopy also delivers it to the mailbox.
		keepCopy: integer("keep_copy", { mode: "boolean" }).notNull().default(false),
		rejectReason: text("reject_reason"),
		priority: integer("priority").notNull().default(0),
		lastMatchedAt: integer("last_matched_at", { mode: "timestamp" }),
		matchCount: integer("match_count").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("routing_rules_domain_scope_idx").on(t.domainId, t.scope, t.enabled),
		index("routing_rules_mailbox_idx").on(t.mailboxId),
		index("routing_rules_priority_idx").on(t.priority),
	],
);

export const webhooks = sqliteTable("webhooks", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	description: text("description"),
	url: text("url").notNull(),
	secret: text("secret").notNull(),
	events: text("events").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	maxAttempts: integer("max_attempts").notNull().default(5),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		webhookId: text("webhook_id")
			.notNull()
			.references(() => webhooks.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		payload: text("payload").notNull(),
		// pending | delivered | failed | retrying | exhausted
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		responseStatus: integer("response_status"),
		error: text("error"),
		durationMs: integer("duration_ms"),
		lastAttemptAt: integer("last_attempt_at", { mode: "timestamp" }),
		nextRetryAt: integer("next_retry_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt),
		index("webhook_deliveries_status_idx").on(t.status),
	],
);

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull().unique(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const pushSubscriptions = sqliteTable(
	"push_subscriptions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		endpoint: text("endpoint").notNull(),
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
		index("push_subscriptions_user_idx").on(t.userId),
		index("push_subscriptions_session_idx").on(t.sessionId),
	],
);

/** Single-use links mailed to a user's recovery address. Only the hash is stored. */
export const passwordResetTokens = sqliteTable(
	"password_reset_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		usedAt: integer("used_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("password_reset_tokens_user_idx").on(t.userId)],
);

/** One-time backup codes for accounts with TOTP, hashed like session tokens. */
export const mfaRecoveryCodes = sqliteTable(
	"mfa_recovery_codes",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		codeHash: text("code_hash").notNull().unique(),
		usedAt: integer("used_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("mfa_recovery_codes_user_idx").on(t.userId)],
);

/**
 * A password that checked out but still needs a second factor. The challenge
 * token stands in for the password on the follow-up request, so the password
 * is never held client-side between the two steps.
 */
export const loginChallenges = sqliteTable("login_challenges", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull().unique(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		metadata: text("metadata"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("audit_logs_actor_idx").on(t.actorUserId),
		index("audit_logs_mailbox_idx").on(t.mailboxId),
		index("audit_logs_created_idx").on(t.createdAt),
	],
);

export const backupSettings = sqliteTable("backup_settings", {
	id: text("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	scheduleType: text("schedule_type", { enum: ["daily", "weekly", "monthly"] })
		.notNull()
		.default("daily"),
	scheduleValue: integer("schedule_value"),
	retentionEnabled: integer("retention_enabled", { mode: "boolean" }).notNull().default(false),
	retentionDays: integer("retention_days").notNull().default(30),
	excludedTableGroups: text("excluded_table_groups").notNull().default("[]"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const appSettings = sqliteTable("app_settings", {
	id: text("id").primaryKey(),
	appName: text("app_name").notNull().default("Mailflare"),
	outboundAttachmentMaxMb: integer("outbound_attachment_max_mb").notNull().default(25),
	/** Per-user Drive storage cap in bytes; null means unlimited. */
	driveStorageLimitBytes: integer("drive_storage_limit_bytes"),
	resendApiKey: text("resend_api_key"),
	/** JSON: AWS access key, secret and region (see src/lib/aws/config.ts). */
	awsConfig: text("aws_config"),
	/** JSON: the shared SES inbound resources Mailflare created (bucket, topic, rule set, webhook token). */
	sesReceiving: text("ses_receiving"),
	resendWebhookId: text("resend_webhook_id"),
	resendWebhookSecret: text("resend_webhook_secret"),
	iconKey: text("icon_key"),
	agentEnabled: integer("agent_enabled", { mode: "boolean" }).notNull().default(true),
	agentProvider: text("agent_provider", { enum: ["cloudflare", "compatible"] }),
	agentPreset: text("agent_preset", { enum: ["openai", "openrouter", "groq", "custom"] }),
	agentBaseUrl: text("agent_base_url"),
	agentApiKey: text("agent_api_key"),
	agentModel: text("agent_model"),
	agentModelRates: text("agent_model_rates"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const licenseSettings = sqliteTable("license_settings", {
	id: text("id").primaryKey(),
	instanceId: text("instance_id").notNull().unique(),
	instanceUrl: text("instance_url"),
	licenseKeyHash: text("license_key_hash"),
	plan: text("plan", { enum: ["community", "pro", "team"] }).notNull().default("community"),
	state: text("state", { enum: ["inactive", "active", "invalid", "expired", "deactivated"] })
		.notNull()
		.default("inactive"),
	features: text("features").notNull().default("[]"),
	// Account seats from Paymug's seatLimit; null is unlimited. Rows predating seats keep one.
	seatLimit: integer("seat_limit").default(1),
	activatedAt: integer("activated_at", { mode: "timestamp" }),
	validatedAt: integer("validated_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const backups = sqliteTable(
	"backups",
	{
		id: text("id").primaryKey(),
		status: text("status", { enum: ["queued", "running", "completed", "failed"] })
			.notNull()
			.default("queued"),
		trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
		r2Key: text("r2_key"),
		filename: text("filename"),
		size: integer("size"),
		error: text("error"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
	},
	(t) => [
		index("backups_created_idx").on(t.createdAt),
		index("backups_status_idx").on(t.status),
	],
);

export const mailboxAgentSettings = sqliteTable("mailbox_agent_settings", {
	mailboxId: text("mailbox_id").primaryKey().references(() => mailboxes.id, { onDelete: "cascade" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	modelId: text("model_id"),
	autoDraftEnabled: integer("auto_draft_enabled", { mode: "boolean" }).notNull().default(false),
	reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
	instructions: text("instructions").notNull().default(""),
	dailyLimit: integer("daily_limit").notNull().default(25),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const aiUsage = sqliteTable("ai_usage", {
	id: text("id").primaryKey(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	source: text("source").notNull(),
	inputTokens: integer("input_tokens"),
	outputTokens: integer("output_tokens"),
	costUsdMicros: integer("cost_usd_micros"),
}, (t) => [index("ai_usage_created_idx").on(t.createdAt)]);

export const agentConversations = sqliteTable("agent_conversations", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	title: text("title").notNull().default("New conversation"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("agent_conversations_owner_idx").on(t.userId, t.mailboxId, t.updatedAt)]);

export const agentChatMessages = sqliteTable("agent_chat_messages", {
	id: text("id").primaryKey(),
	conversationId: text("conversation_id").notNull().references(() => agentConversations.id, { onDelete: "cascade" }),
	role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
	content: text("content").notNull(),
	toolName: text("tool_name"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [index("agent_chat_messages_conversation_idx").on(t.conversationId, t.createdAt)]);

export const agentJobs = sqliteTable("agent_jobs", {
	id: text("id").primaryKey(),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	sourceMessageId: text("source_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
	reviewerUserId: text("reviewer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	status: text("status", { enum: ["pending", "running", "completed", "skipped", "failed"] }).notNull().default("pending"),
	attempts: integer("attempts").notNull().default(0),
	nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	leaseUntil: integer("lease_until", { mode: "timestamp" }),
	draftId: text("draft_id").references(() => messages.id, { onDelete: "set null" }),
	reason: text("reason"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex("agent_jobs_source_idx").on(t.mailboxId, t.sourceMessageId), index("agent_jobs_due_idx").on(t.status, t.nextAttemptAt)]);

export const agentDraftMetadata = sqliteTable("agent_draft_metadata", {
	draftId: text("draft_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	origin: text("origin", { enum: ["chat", "auto", "mcp"] }).notNull(),
	sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
	revision: integer("revision").notNull().default(1),
	humanEditedAt: integer("human_edited_at", { mode: "timestamp" }),
	scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const agentSendApprovals = sqliteTable("agent_send_approvals", {
	id: text("id").primaryKey(),
	draftId: text("draft_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	requestKeyId: text("request_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
	revision: integer("revision").notNull(),
	payloadHash: text("payload_hash").notNull(),
	status: text("status", { enum: ["pending", "claimed", "sent", "unknown", "expired", "cancelled"] }).notNull().default("pending"),
	claimedAt: integer("claimed_at", { mode: "timestamp" }),
	messageId: text("message_id"),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
	index("agent_send_approvals_user_idx").on(t.userId, t.status),
	uniqueIndex("agent_send_approvals_delivery_idx").on(t.draftId).where(sql`status IN ('claimed', 'sent', 'unknown')`),
]);

export const mcpKeyMailboxes = sqliteTable("mcp_key_mailboxes", {
	keyId: text("key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("mcp_key_mailbox_idx").on(t.keyId, t.mailboxId)]);

export const driveItems = sqliteTable("drive_items", {
	id: text("id").primaryKey(),
	ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	parentId: text("parent_id"),
	kind: text("kind", { enum: ["file", "folder"] }).notNull(),
	name: text("name").notNull(),
	r2Key: text("r2_key"),
	size: integer("size").notNull().default(0),
	contentType: text("content_type").notNull().default("application/octet-stream"),
	// Set while a multipart upload is in flight; such rows stay hidden until the upload completes.
	uploadId: text("upload_id"),
	uploadPartSize: integer("upload_part_size"),
	uploadFingerprint: text("upload_fingerprint"),
	linkToken: text("link_token"),
	trashedAt: integer("trashed_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
	index("drive_items_owner_parent_idx").on(t.ownerId, t.parentId),
	uniqueIndex("drive_items_link_token_idx").on(t.linkToken),
]);

export const driveUploadParts = sqliteTable("drive_upload_parts", {
	itemId: text("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
	partNumber: integer("part_number").notNull(),
	etag: text("etag").notNull(),
}, (t) => [uniqueIndex("drive_upload_parts_idx").on(t.itemId, t.partNumber)]);

export const driveShares = sqliteTable("drive_shares", {
	id: text("id").primaryKey(),
	itemId: text("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	role: text("role", { enum: ["view", "edit"] }).notNull().default("view"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
	uniqueIndex("drive_shares_item_user_idx").on(t.itemId, t.userId),
	index("drive_shares_user_idx").on(t.userId),
]);

export const schema = {
	users,
	domains,
	mailboxes,
	mailboxAliases,
	autoReplyDeliveries,
	mailboxAccess,
	contacts,
	folders,
	apiKeys,
	messages,
	spamTokenStats,
	spamReputation,
	spamFeedback,
	messageAttachments,
	sharedAttachmentLinks,
	outboundJobs,
	emailTemplates,
	calendarEvents,
	bookingEvents,
	routingRules,
	webhooks,
	webhookDeliveries,
	sessions,
	pushSubscriptions,
	driveItems,
	driveUploadParts,
	driveShares,
	auditLogs,
	backupSettings,
	backups,
	appSettings,
	licenseSettings,
	mailboxAgentSettings,
	aiUsage,
	agentConversations,
	agentChatMessages,
	agentJobs,
	agentDraftMetadata,
	agentSendApprovals,
	mcpKeyMailboxes,
};
