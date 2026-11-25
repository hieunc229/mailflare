import { and, count, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { spamFeedback, spamTokenStats } from "@/db/schema";
import type { BayesianResult } from "./types";
import { MAX_BAYESIAN_TOKENS, SPAM_WEIGHTS } from "./weights";

export async function classifyTokens(db: AppDatabase, mailboxId: string, tokens: string[]): Promise<BayesianResult> {
	const [spamTotalRow, hamTotalRow] = await Promise.all([
		db.select({ value: count() }).from(spamFeedback).where(and(eq(spamFeedback.mailboxId, mailboxId), eq(spamFeedback.classification, "spam"))),
		db.select({ value: count() }).from(spamFeedback).where(and(eq(spamFeedback.mailboxId, mailboxId), eq(spamFeedback.classification, "ham"))),
	]);
	const spamTotal = spamTotalRow[0]?.value ?? 0;
	const hamTotal = hamTotalRow[0]?.value ?? 0;
	const trainedMessages = spamTotal + hamTotal;
	if (spamTotal === 0 || hamTotal === 0 || tokens.length === 0) {
		return { probability: 0.5, contribution: 0, trainedMessages, strongestTokens: [] };
	}

	const chunks: string[][] = [];
	for (let index = 0; index < tokens.length; index += 90) chunks.push(tokens.slice(index, index + 90));
	// Chunks are independent reads; Promise.all keeps chunk order, so ties sort exactly as before.
	const rows: Array<typeof spamTokenStats.$inferSelect> = (await Promise.all(chunks.map((chunk) => db.select().from(spamTokenStats).where(and(
		eq(spamTokenStats.mailboxId, mailboxId),
		inArray(spamTokenStats.token, chunk),
	))))).flat();
	const strongestTokens = rows.map((row) => {
		const spamRate = (row.spamCount + 1) / (spamTotal + 2);
		const hamRate = (row.hamCount + 1) / (hamTotal + 2);
		const probability = Math.max(0.1, Math.min(0.9, spamRate / (spamRate + hamRate)));
		return { token: row.token, probability };
	}).sort((a, b) => Math.abs(b.probability - 0.5) - Math.abs(a.probability - 0.5)).slice(0, MAX_BAYESIAN_TOKENS);
	if (strongestTokens.length === 0) return { probability: 0.5, contribution: 0, trainedMessages, strongestTokens };

	let spamProduct = 1;
	let hamProduct = 1;
	for (const token of strongestTokens) {
		spamProduct *= token.probability;
		hamProduct *= 1 - token.probability;
	}
	const probability = spamProduct / (spamProduct + hamProduct);
	const fullContribution = (probability - 0.5) * SPAM_WEIGHTS.content.maximum * 2;
	const reliability = Math.min(1, Math.min(spamTotal, hamTotal) / 20);
	return {
		probability,
		contribution: Math.round(fullContribution * reliability),
		trainedMessages,
		strongestTokens,
	};
}
