import { getLicenseEntitlements } from "@/lib/licenses/service";

/** Whether this installation may book rooms (D-13: a Team licence), read lazily: callers hand it to `rebookEvents`, which asks only when an event has a declined room. */
export const roomsBookable = (env: CloudflareEnv) => async (): Promise<boolean> => (await getLicenseEntitlements(env)).canShareMailboxes;
