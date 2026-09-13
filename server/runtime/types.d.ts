import type { Mailer } from "./mailer";
import type { InProcessQueue } from "./queue";
import type { RealtimeHubRegistry } from "./realtime";
import type { SqliteDatabase } from "./sqlite-database";

export type NodeRuntime = {
	env: CloudflareEnv;
	dataDir: string;
	database: SqliteDatabase;
	mailer: Mailer;
	inboundQueue: InProcessQueue;
	outboundQueue: InProcessQueue;
	realtime: RealtimeHubRegistry;
};
