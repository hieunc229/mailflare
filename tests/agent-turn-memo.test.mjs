import assert from "node:assert/strict";
import test from "node:test";
import { agentTurnPropsEqual, uniqueAgentDraftActions } from "../src/components/agent/utils.ts";

const noop = () => {};
const message = (id, role, content = "") => ({ id, role, content });
const makeTurn = (parts = {}) => ({ id: "t", user: message("u", "user", "hi"), assistant: message("a", "assistant", "answer"), activity: [], durationMs: null, running: false, ...parts });
const props = (turn, extra = {}) => ({ turn, draftActions: [], onOpenDraft: noop, onApproveDraft: noop, onApproveAction: noop, approvingId: null, ...extra });

test("identical messages with new handlers and a new turn object are equal", () => {
	const turn = makeTurn();
	const next = { ...turn };
	assert.equal(agentTurnPropsEqual(props(turn), props(next, { onOpenDraft: () => {}, onApproveDraft: () => {}, onApproveAction: () => {} })), true);
});

test("a changed assistant message is not equal", () => {
	const turn = makeTurn();
	assert.equal(agentTurnPropsEqual(props(turn), props({ ...turn, assistant: { ...turn.assistant, content: `${turn.assistant.content}x` } })), false);
});

test("a new activity item, running flip, durationMs or approvingId change is not equal", () => {
	const tool = message("tool", "tool", "{}");
	const turn = makeTurn({ activity: [tool] });
	assert.equal(agentTurnPropsEqual(props(turn), props({ ...turn, activity: [tool, message("more", "reasoning", "x")] })), false);
	assert.equal(agentTurnPropsEqual(props(turn), props({ ...turn, running: true })), false);
	assert.equal(agentTurnPropsEqual(props(turn), props({ ...turn, durationMs: 5 })), false);
	assert.equal(agentTurnPropsEqual(props(turn), props(turn, { approvingId: "d1" })), false);
});

test("draft actions of other turns are ignored", () => {
	const tool = message("tool", "tool", "{}");
	const turn = makeTurn({ activity: [tool] });
	const other = { messageId: "elsewhere", draftId: "d9", revision: 1, scheduledAt: null };
	const own = { messageId: "tool", draftId: "d1", revision: 1, scheduledAt: null };
	assert.equal(agentTurnPropsEqual(props(turn, { draftActions: [other, own] }), props(turn, { draftActions: [{ ...other, revision: 2 }, own] })), true);
	assert.equal(agentTurnPropsEqual(props(turn, { draftActions: [own] }), props(turn, { draftActions: [{ ...own, revision: 2 }] })), false);
});

test("tool result JSON is parsed once per message", () => {
	let reads = 0;
	const item = { id: "m1", role: "tool", toolState: "used", get content() { reads += 1; return JSON.stringify({ draftId: "d1", revision: 1, status: "draft_created" }); } };
	const expected = [{ messageId: "m1", draftId: "d1", revision: 1, scheduledAt: null }];
	assert.deepEqual(uniqueAgentDraftActions([item]), expected);
	assert.deepEqual(uniqueAgentDraftActions([item]), expected);
	assert.equal(reads, 1);
});
