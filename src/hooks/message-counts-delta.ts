import type { MessageCountsDelta } from "./types";

/** Whether counts scoped to `mailboxId` include the messages a delta describes; all-mailbox counts include every one. */
export function deltaAppliesToMailbox(delta: MessageCountsDelta, mailboxId: string | null | undefined): boolean {
	return !delta.mailboxId || !mailboxId || delta.mailboxId === mailboxId;
}
