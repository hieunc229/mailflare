import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { kit } from "./kits";

// Written once against the dialect kit (see kits.ts): SQLite by default, PostgreSQL or MySQL when
// DATABASE_URL selects one. Everything below is typed as SQLite, which is the shape the app queries.
const { table: sqliteTable, text, integer, bool, timestamp, autoId, index, uniqueIndex, desc, nowSeconds } = kit;

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
	isPrimaryAdmin: bool("is_primary_admin").notNull().default(false),
	disabled: bool("disabled").notNull().default(false),
	canManageMailboxes: bool("can_manage_mailboxes").notNull().default(false),
	// Capabilities the primary admin grants to other admins.
	canManageDomains: bool("can_manage_domains").notNull().default(false),
	canManageUsers: bool("can_manage_users").notNull().default(false),
	keyboardShortcutsEnabled: bool("keyboard_shortcuts_enabled").notNull().default(true),
	spamProtectionEnabled: bool("spam_protection_enabled").notNull().default(true),
	/** Days a message may stay in Trash or Spam before the scheduled purge deletes it; null keeps it forever. */
	trashRetentionDays: integer("trash_retention_days"),
	// Off shows the mailbox only. On shows Name <mailbox> on To, Cc, and Bcc.
	showFullRecipientAddresses: bool("show_full_recipient_addresses").notNull().default(false),
	// When the reader loads remote images and styles without being asked: always ask, only for senders not yet allowed, or always.
	remoteContentMode: text("remote_content_mode", { enum: ["ask", "new_sender", "allow"] }).notNull().default("allow"),
	// TOTP second factor. The secret is written at enrolment and only counts
	// once the user has proven a code from their authenticator.
	totpSecret: text("totp_secret"),
	totpEnabled: bool("totp_enabled").notNull().default(false),
	totpConfirmedAt: timestamp("totp_confirmed_at"),
	lastSignInAt: timestamp("last_sign_in_at"),
	// Set when an admin deletes the account. The account is also `disabled` and can be restored until the
	// retention window ends, after which the scheduled purge removes it and its data.
	deletedAt: timestamp("deleted_at"),
	createdByUserId: text("created_by_user_id").references((): AnySQLiteColumn => users.id, { onDelete: "set null" }),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [
	uniqueIndex("users_booking_username_idx").on(t.bookingUsername),
	index("users_created_by_idx").on(t.createdByUserId),
]);

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
		sendingRequested: bool("sending_requested").notNull().default(false),
		sendingEnabled: bool("sending_enabled").notNull().default(false),
		routingEnabled: bool("routing_enabled").notNull().default(false),
		/** The operator skipped adding/checking DNS; set until they confirm the records exist. */
		dnsSkipped: bool("dns_skipped").notNull().default(false),
		createdAt: timestamp("created_at")
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
		autoReplyEnabled: bool("auto_reply_enabled").notNull().default(false),
		autoReplySubject: text("auto_reply_subject").notNull().default("Out of office"),
		autoReplyBody: text("auto_reply_body").notNull().default(""),
		avatarKey: text("avatar_key"),
		type: text("type", { enum: ["personal", "shared"] }).notNull().default("personal"),
		useAllDomains: bool("use_all_domains").notNull().default(true),
		disabled: bool("disabled").notNull().default(false),
		createdAt: timestamp("created_at")
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
		createdAt: timestamp("created_at")
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
		sentAt: timestamp("sent_at").notNull(),
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
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("mailbox_access_mailbox_user_idx").on(t.mailboxId, t.userId),
		index("mailbox_access_user_idx").on(t.userId),
		index("mailbox_access_mailbox_idx").on(t.mailboxId),
		index("mailbox_access_created_by_idx").on(t.createdByUserId),
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
		blocked: bool("blocked").notNull().default(false),
		// Set when the user allows remote content from this sender; "new_sender" mode loads it without asking afterwards.
		remoteContentAllowed: bool("remote_content_allowed").notNull().default(false),
		lastSeenAt: timestamp("last_seen_at"),
		createdAt: timestamp("created_at")
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
		createdAt: timestamp("created_at")
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

/**
 * JMAP change log, written only by the `jmap_changes_*` triggers of migration
 * 0064: one row per created, updated or destroyed Email (and per folder or
 * mailbox change), so `Email/changes`, `Mailbox/changes` and `Thread/changes`
 * return real deltas. `seq` is the state; rows older than the retention
 * window are pruned and `jmap_change_floor` records the last pruned seq.
 */
export const jmapChanges = sqliteTable(
	"jmap_changes",
	{
		seq: autoId("seq"),
		mailboxId: text("mailbox_id").notNull(),
		objectType: text("object_type", { enum: ["email", "mailbox"] }).notNull(),
		objectId: text("object_id").notNull(),
		threadId: text("thread_id"),
		change: text("change", { enum: ["created", "updated", "destroyed"] }).notNull(),
		createdAt: integer("created_at").notNull().default(nowSeconds),
	},
	(table) => [index("jmap_changes_mailbox_seq_idx").on(table.mailboxId, table.seq)],
);

export const jmapChangeFloor = sqliteTable("jmap_change_floor", {
	id: integer("id").primaryKey(),
	seq: integer("seq").notNull().default(0),
});

export const apiKeys = sqliteTable("api_keys", {
	id: text("id").primaryKey(),
	/** `device` keys come from a mobile sign-in (`/api/auth/device`) and are listed under Devices. */
	kind: text("kind", { enum: ["legacy", "mcp", "device"] }).notNull().default("legacy"),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	prefix: text("prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	scopes: text("scopes").notNull(),
	mailboxScopeEnabled: bool("mailbox_scope_enabled").notNull().default(false),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
	lastUsedAt: timestamp("last_used_at"),
}, (t) => [index("api_keys_user_idx").on(t.userId)]);

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
		/** Full Reply-To header, comma-joined. Replies go here instead of `fromAddr` when set. */
		replyTo: text("reply_to"),
		subject: text("subject"),
		snippet: text("snippet"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),
		rawR2Key: text("raw_r2_key"),
		status: text("status").notNull().default("received"),
		read: bool("read").notNull().default(false),
		starred: bool("starred").notNull().default(false),
		snoozedUntil: timestamp("snoozed_until"),
		threadId: text("thread_id"),
		// RFC 5322 threading headers, kept so replies land in the right conversation
		// and so outgoing replies can carry them on to the recipient's client.
		inReplyTo: text("in_reply_to"),
		references: text("references_header"),
		spamScore: integer("spam_score"),
		spamVerdict: text("spam_verdict", { enum: ["inbox", "suspicious", "spam"] }),
		spamSignals: text("spam_signals"),
		spamAnalyzedAt: timestamp("spam_analyzed_at"),
		spamAnalysisError: text("spam_analysis_error"),
		/** When the message last entered Trash or Spam; maintained by triggers (migration 0053). */
		trashedAt: timestamp("trashed_at"),
		createdAt: timestamp("created_at")
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
			desc(t.createdAt),
			desc(t.id),
		),
		index("messages_thread_key_idx").on(
			t.mailboxId,
			t.status,
			t.folderId,
			sql`coalesce(${t.threadId}, ${t.id})`,
			t.createdAt,
		),
		index("messages_mailbox_thread_key_idx").on(t.mailboxId, sql`coalesce(${t.threadId}, ${t.id})`),
		index("messages_nav_cover_idx").on(
			t.mailboxId,
			t.status,
			t.folderId,
			desc(t.createdAt),
			desc(t.id),
			t.direction,
			t.read,
			t.threadId,
			t.snoozedUntil,
		),
		// Covering index for the folder-counts GROUP BY: lets the counts
		// endpoint stream grouped rows straight off the index instead of
		// sorting the whole table.
		index("messages_counts_cover_idx").on(
			t.mailboxId,
			t.folderId,
			t.direction,
			t.status,
			t.read,
			t.starred,
			t.snoozedUntil,
		),
		// Conversation paging partitions by coalesce(thread_id, id) and orders
		// each partition by created_at desc, so the thread key must precede
		// created_at for the index to feed the window in sorted order. The
		// snoozed_until filter rides the tail column and never touches the
		// table.
		index("messages_conv_cover_idx").on(
			t.mailboxId,
			t.status,
			sql`coalesce(${t.threadId}, ${t.id})`,
			t.createdAt,
			t.id,
			t.snoozedUntil,
		),
	],
);

export const spamTokenStats = sqliteTable(
	"spam_token_stats",
	{
		mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
		token: text("token").notNull(),
		spamCount: integer("spam_count").notNull().default(0),
		hamCount: integer("ham_count").notNull().default(0),
		updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
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
		firstSeenAt: timestamp("first_seen_at").notNull().$defaultFn(() => new Date()),
		lastSeenAt: timestamp("last_seen_at").notNull().$defaultFn(() => new Date()),
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
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		index("spam_feedback_mailbox_idx").on(t.mailboxId),
		index("spam_feedback_actor_user_idx").on(t.actorUserId),
	],
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
		trashedAt: timestamp("trashed_at"),
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("message_attachments_message_idx").on(t.messageId)],
);

export const sharedAttachmentLinks = sqliteTable("shared_attachment_links", {
	id: text("id").primaryKey(),
	attachmentId: text("attachment_id").notNull().references(() => messageAttachments.id, { onDelete: "cascade" }).unique(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
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
	scheduledAt: timestamp("scheduled_at"),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at")
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [
	index("outbound_jobs_user_idx").on(t.userId),
	index("outbound_jobs_message_idx").on(t.messageId),
]);

/** One row per sent message that carries an open-tracking pixel; the token is the pixel URL's secret. */
export const messageTracking = sqliteTable(
	"message_tracking",
	{
		token: text("token").primaryKey(),
		messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
		/** Opens that were not classified as automated prefetches. */
		openCount: integer("open_count").notNull().default(0),
		firstOpenedAt: timestamp("first_opened_at"),
		lastOpenedAt: timestamp("last_opened_at"),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("message_tracking_message_idx").on(t.messageId)],
);

/** Hostname under a domain that serves its read-receipt pixels, so the pixel matches the sender. Kept out of `domains` so sending works before the migration. */
export const domainTrackingHosts = sqliteTable(
	"domain_tracking_hosts",
	{
		domainId: text("domain_id").primaryKey().references(() => domains.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("domain_tracking_hosts_hostname_idx").on(t.hostname)],
);

export const messageOpens = sqliteTable(
	"message_opens",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().references(() => messageTracking.token, { onDelete: "cascade" }),
		openedAt: timestamp("opened_at").notNull(),
		client: text("client"),
		device: text("device"),
		country: text("country"),
		city: text("city"),
		automated: bool("automated").notNull().default(false),
	},
	(t) => [index("message_opens_token_idx").on(t.token, t.openedAt)],
);

/**
 * Per-user composer defaults. Kept out of `users` because every session
 * lookup selects the whole users row, which would fail before the migration.
 */
export const userComposePreferences = sqliteTable("user_compose_preferences", {
	userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
	trackOpensDefault: bool("track_opens_default").notNull().default(false),
	undoSendSeconds: integer("undo_send_seconds").notNull().default(15),
	updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
});

/**
 * "Remind me if there is no reply": a sent message whose thread comes back to the
 * inbox at `dueAt` unless an inbound message joined the thread after it.
 */
export const followUps = sqliteTable(
	"follow_ups",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		dueAt: timestamp("due_at").notNull(),
		status: text("status", { enum: ["pending", "due", "replied", "dismissed"] }).notNull().default("pending"),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("follow_ups_message_idx").on(t.messageId),
		index("follow_ups_status_due_idx").on(t.status, t.dueAt),
		index("follow_ups_user_status_idx").on(t.userId, t.status),
	],
);

export const emailTemplates = sqliteTable(
	"email_templates",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		subject: text("subject").notNull().default(""),
		textBody: text("text_body").notNull().default(""),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
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
		repeatUntil: timestamp("repeat_until"),
		excludedOccurrences: text("excluded_occurrences").notNull().default("[]"),
		timeZone: text("time_zone"),
		startsAt: timestamp("starts_at").notNull(),
		endsAt: timestamp("ends_at").notNull(),
		/** Minutes before an occurrence's start to send a push reminder; null means no reminder. */
		reminderMinutes: integer("reminder_minutes"),
		/** Start of the latest occurrence a reminder was sent for; dedupes the five-minute cron. */
		lastRemindedStart: timestamp("last_reminded_start"),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		index("calendar_events_user_starts_idx").on(t.userId, t.startsAt),
		index("calendar_events_mailbox_idx").on(t.mailboxId),
	],
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
		enabled: bool("enabled").notNull().default(true),
		createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
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
		enabled: bool("enabled").notNull().default(true),
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
		keepCopy: bool("keep_copy").notNull().default(false),
		rejectReason: text("reject_reason"),
		priority: integer("priority").notNull().default(0),
		lastMatchedAt: timestamp("last_matched_at"),
		matchCount: integer("match_count").notNull().default(0),
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("routing_rules_domain_scope_idx").on(t.domainId, t.scope, t.enabled),
		index("routing_rules_mailbox_idx").on(t.mailboxId),
		index("routing_rules_priority_idx").on(t.priority),
		index("routing_rules_user_idx").on(t.userId),
		index("routing_rules_folder_idx").on(t.folderId),
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
	enabled: bool("enabled").notNull().default(true),
	maxAttempts: integer("max_attempts").notNull().default(5),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [index("webhooks_user_idx").on(t.userId)]);

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
		lastAttemptAt: timestamp("last_attempt_at"),
		nextRetryAt: timestamp("next_retry_at"),
		createdAt: timestamp("created_at")
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
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/** A native app's push registration (APNs), owned by the device's API key. */
export const pushDevices = sqliteTable(
	"push_devices",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		apiKeyId: text("api_key_id")
			.notNull()
			.references(() => apiKeys.id, { onDelete: "cascade" }),
		platform: text("platform", { enum: ["apns"] }).notNull(),
		token: text("token").notNull(),
		environment: text("environment", { enum: ["production", "sandbox"] }).notNull().default("production"),
		topic: text("topic").notNull(),
		/** Base64 raw P-256 public key; previews are encrypted to it. */
		publicKey: text("public_key"),
		previews: bool("previews").notNull().default(true),
		/** The app's own id for this account; echoed in pushes so a tap opens the right account. */
		clientRef: text("client_ref"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("push_devices_platform_token_user_idx").on(table.platform, table.token, table.userId),
		index("push_devices_user_idx").on(table.userId),
		index("push_devices_api_key_idx").on(table.apiKeyId),
	],
);

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
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at")
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
		expiresAt: timestamp("expires_at").notNull(),
		usedAt: timestamp("used_at"),
		createdAt: timestamp("created_at")
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
		usedAt: timestamp("used_at"),
		createdAt: timestamp("created_at")
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
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at")
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [index("login_challenges_user_idx").on(t.userId)]);

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
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("audit_logs_actor_idx").on(t.actorUserId),
		index("audit_logs_mailbox_idx").on(t.mailboxId),
		index("audit_logs_created_idx").on(t.createdAt),
		index("audit_logs_message_id_idx").on(t.messageId),
		index("audit_logs_target_user_idx").on(t.targetUserId),
	],
);

export const backupSettings = sqliteTable("backup_settings", {
	id: text("id").primaryKey(),
	enabled: bool("enabled").notNull().default(true),
	scheduleType: text("schedule_type", { enum: ["daily", "weekly", "monthly"] })
		.notNull()
		.default("daily"),
	scheduleValue: integer("schedule_value"),
	retentionEnabled: bool("retention_enabled").notNull().default(false),
	retentionDays: integer("retention_days").notNull().default(30),
	excludedTableGroups: text("excluded_table_groups").notNull().default("[]"),
	updatedAt: timestamp("updated_at")
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
	agentEnabled: bool("agent_enabled").notNull().default(true),
	agentProvider: text("agent_provider", { enum: ["cloudflare", "compatible"] }),
	agentPreset: text("agent_preset", { enum: ["openai", "openrouter", "groq", "custom"] }),
	agentBaseUrl: text("agent_base_url"),
	agentApiKey: text("agent_api_key"),
	agentModel: text("agent_model"),
	agentModelRates: text("agent_model_rates"),
	/** Spam analysis lookups; the SPAMHAUS_DQS_KEY and ABUSECH_AUTH_KEY env vars apply when these are null. */
	spamhausDqsKey: text("spamhaus_dqs_key"),
	abusechAuthKey: text("abusech_auth_key"),
	spamDomainAgeCheck: bool("spam_domain_age_check").notNull().default(true),
	/** JSON: brands the administrator added for display-name impersonation checks (see src/lib/spam/settings.ts). */
	spamBrands: text("spam_brands"),
	updatedAt: timestamp("updated_at")
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
	activatedAt: timestamp("activated_at"),
	validatedAt: timestamp("validated_at"),
	updatedAt: timestamp("updated_at")
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
		createdAt: timestamp("created_at")
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
	},
	(t) => [
		index("backups_created_idx").on(t.createdAt),
		index("backups_status_idx").on(t.status),
		index("backups_created_by_idx").on(t.createdByUserId),
	],
);

export const mailboxAgentSettings = sqliteTable("mailbox_agent_settings", {
	mailboxId: text("mailbox_id").primaryKey().references(() => mailboxes.id, { onDelete: "cascade" }),
	enabled: bool("enabled").notNull().default(false),
	modelId: text("model_id"),
	autoDraftEnabled: bool("auto_draft_enabled").notNull().default(false),
	reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
	instructions: text("instructions").notNull().default(""),
	dailyLimit: integer("daily_limit").notNull().default(25),
	updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("mailbox_agent_settings_reviewer_idx").on(t.reviewerUserId)]);

export const aiUsage = sqliteTable("ai_usage", {
	id: text("id").primaryKey(),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
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
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
	index("agent_conversations_owner_idx").on(t.userId, t.mailboxId, t.updatedAt),
	index("agent_conversations_mailbox_idx").on(t.mailboxId),
]);

export const agentChatMessages = sqliteTable("agent_chat_messages", {
	id: text("id").primaryKey(),
	conversationId: text("conversation_id").notNull().references(() => agentConversations.id, { onDelete: "cascade" }),
	role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
	content: text("content").notNull(),
	toolName: text("tool_name"),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
}, (t) => [index("agent_chat_messages_conversation_idx").on(t.conversationId, t.createdAt)]);

export const agentJobs = sqliteTable("agent_jobs", {
	id: text("id").primaryKey(),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	sourceMessageId: text("source_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
	reviewerUserId: text("reviewer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	status: text("status", { enum: ["pending", "running", "completed", "skipped", "failed"] }).notNull().default("pending"),
	attempts: integer("attempts").notNull().default(0),
	nextAttemptAt: timestamp("next_attempt_at").notNull().$defaultFn(() => new Date()),
	leaseUntil: timestamp("lease_until"),
	draftId: text("draft_id").references(() => messages.id, { onDelete: "set null" }),
	reason: text("reason"),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
	uniqueIndex("agent_jobs_source_idx").on(t.mailboxId, t.sourceMessageId),
	index("agent_jobs_due_idx").on(t.status, t.nextAttemptAt),
	index("agent_jobs_source_message_idx").on(t.sourceMessageId),
	index("agent_jobs_draft_idx").on(t.draftId),
	index("agent_jobs_reviewer_idx").on(t.reviewerUserId),
]);

export const agentDraftMetadata = sqliteTable("agent_draft_metadata", {
	draftId: text("draft_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	origin: text("origin", { enum: ["chat", "auto", "mcp"] }).notNull(),
	sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
	revision: integer("revision").notNull().default(1),
	humanEditedAt: timestamp("human_edited_at"),
	scheduledAt: timestamp("scheduled_at"),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
	index("agent_draft_meta_source_msg_idx").on(t.sourceMessageId),
	index("agent_draft_metadata_mailbox_idx").on(t.mailboxId),
]);

export const agentSendApprovals = sqliteTable("agent_send_approvals", {
	id: text("id").primaryKey(),
	draftId: text("draft_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	requestKeyId: text("request_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
	revision: integer("revision").notNull(),
	payloadHash: text("payload_hash").notNull(),
	status: text("status", { enum: ["pending", "claimed", "sent", "unknown", "expired", "cancelled"] }).notNull().default("pending"),
	claimedAt: timestamp("claimed_at"),
	messageId: text("message_id"),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
	index("agent_send_approvals_user_idx").on(t.userId, t.status),
	uniqueIndex("agent_send_approvals_delivery_idx").on(t.draftId).where(sql`status IN ('claimed', 'sent', 'unknown')`),
	index("agent_send_approvals_request_key_idx").on(t.requestKeyId),
	index("agent_send_approvals_mailbox_idx").on(t.mailboxId),
	index("agent_send_approvals_draft_idx").on(t.draftId),
]);

export const mcpKeyMailboxes = sqliteTable("mcp_key_mailboxes", {
	keyId: text("key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
}, (t) => [
	uniqueIndex("mcp_key_mailbox_idx").on(t.keyId, t.mailboxId),
	index("mcp_key_mailboxes_mailbox_idx").on(t.mailboxId),
]);

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
	trashedAt: timestamp("trashed_at"),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
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
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
	uniqueIndex("drive_shares_item_user_idx").on(t.itemId, t.userId),
	index("drive_shares_user_idx").on(t.userId),
]);

export const importJobs = sqliteTable("import_jobs", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
	mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
	kind: text("kind", { enum: ["file", "imap"] }).notNull(),
	label: text("label").notNull(),
	status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull().default("queued"),
	// Messages known to be part of the job; for IMAP it grows as each source folder is counted.
	total: integer("total").notNull().default(0),
	processed: integer("processed").notNull().default(0),
	imported: integer("imported").notNull().default(0),
	skipped: integer("skipped").notNull().default(0),
	// What to import (JSON, never credentials) and where the next queue message resumes (JSON).
	spec: text("spec").notNull(),
	cursor: text("cursor").notNull().default("{}"),
	// Up to a handful of per-message error strings (JSON array); errorCount is the true total.
	errors: text("errors").notNull().default("[]"),
	errorCount: integer("error_count").notNull().default(0),
	error: text("error"),
	createdAt: timestamp("created_at").notNull().$defaultFn(() => new Date()),
	startedAt: timestamp("started_at"),
	updatedAt: timestamp("updated_at").notNull().$defaultFn(() => new Date()),
	finishedAt: timestamp("finished_at"),
}, (t) => [index("import_jobs_user_idx").on(t.userId, t.createdAt), index("import_jobs_status_idx").on(t.status, t.updatedAt)]);

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
	importJobs,
};
