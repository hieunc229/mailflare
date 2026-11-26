import type { GroupCandidate, GroupMemberView, GroupSummary } from "@/lib/groups/types";

export type { GroupCandidate, GroupMemberView, GroupSummary };

export type WhoCanPost = GroupSummary["whoCanPost"];

export type GroupDomain = { id: string; hostname: string };

export type GroupsListResponse = { groups: GroupSummary[]; domains: GroupDomain[] };
export type GroupDetailResponse = { group: GroupSummary; members: GroupMemberView[] };

/** What the add-members box can add: a search result, or the typed address of someone outside. */
export type AddOption = GroupCandidate | { kind: "external"; id: string; name: string; address: string };
