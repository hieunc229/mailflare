ALTER TABLE "users" ADD COLUMN "require_second_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "passkey_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "security_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "users" SET "require_second_factor" = "totp_enabled";--> statement-breakpoint
CREATE TABLE "passkey_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"credential_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text,
	"name" text NOT NULL,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "passkey_credentials_credential_hash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE INDEX "passkey_credentials_user_idx" ON "passkey_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"ceremony_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text,
	"binding_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "webauthn_challenges_ceremony_hash_unique" UNIQUE("ceremony_hash")
);
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_idx" ON "webauthn_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE TABLE "passkey_enrollment_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"created_by_user_id" text,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "passkey_enrollment_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "passkey_enrollment_grants_user_idx" ON "passkey_enrollment_grants" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "auth_step_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"target_user_id" text,
	"security_version" bigint DEFAULT 0 NOT NULL,
	"actor_security_version" bigint DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "auth_step_ups_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "auth_step_ups_user_idx" ON "auth_step_ups" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_enrollment_grants" ADD CONSTRAINT "passkey_enrollment_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_enrollment_grants" ADD CONSTRAINT "passkey_enrollment_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_step_ups" ADD CONSTRAINT "auth_step_ups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION mailflare_passkey_count_insert() RETURNS trigger AS $$
BEGIN
	UPDATE users SET passkey_count = passkey_count + 1 WHERE id = NEW.user_id;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER passkey_credentials_count_insert AFTER INSERT ON passkey_credentials
FOR EACH ROW EXECUTE FUNCTION mailflare_passkey_count_insert();--> statement-breakpoint
CREATE FUNCTION mailflare_passkey_count_delete() RETURNS trigger AS $$
BEGIN
	UPDATE users SET passkey_count = passkey_count - 1 WHERE id = OLD.user_id;
	UPDATE users SET require_second_factor = false
	WHERE id = OLD.user_id
		AND passkey_count = 0
		AND NOT totp_enabled
		AND deleted_at IS NULL;
	IF (SELECT passkey_count FROM users WHERE id = OLD.user_id) = 0
		AND (SELECT deleted_at FROM users WHERE id = OLD.user_id) IS NULL
		AND (SELECT password_hash FROM users WHERE id = OLD.user_id) = '!passkey-only' THEN
		RAISE EXCEPTION 'last-auth-method';
	END IF;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER passkey_credentials_count_delete AFTER DELETE ON passkey_credentials
FOR EACH ROW EXECUTE FUNCTION mailflare_passkey_count_delete();--> statement-breakpoint
CREATE FUNCTION mailflare_last_password_update() RETURNS trigger AS $$
BEGIN
	IF NEW.password_hash = '!passkey-only' AND NEW.passkey_count = 0 THEN
		RAISE EXCEPTION 'last-auth-method';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_last_password_update BEFORE UPDATE OF password_hash ON users
FOR EACH ROW EXECUTE FUNCTION mailflare_last_password_update();--> statement-breakpoint
CREATE FUNCTION mailflare_require_second_factor_update() RETURNS trigger AS $$
BEGIN
	IF NEW.require_second_factor AND NEW.passkey_count = 0 AND NOT NEW.totp_enabled AND NEW.deleted_at IS NULL THEN
		RAISE EXCEPTION 'second-factor-unavailable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER users_require_second_factor_update BEFORE UPDATE OF require_second_factor ON users
FOR EACH ROW EXECUTE FUNCTION mailflare_require_second_factor_update();
