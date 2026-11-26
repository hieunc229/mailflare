import type { GroupCandidate, GroupMemberView, GroupSummary } from "@/lib/groups/types";

export type { GroupCandidate, GroupMemberView, GroupSummary };

export type WhoCanPost = GroupSummary["whoCanPost"];

export type GroupDomain = { id: string; hostname: string };

export type GroupsListResponse = { groups: GroupSummary[]; domains: GroupDomain[] };
export type GroupDetailResponse = { group: GroupSummary; members: GroupMemberView[] };
