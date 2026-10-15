import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { THREAD_NOTE_MAX_LENGTH, getThreadNoteForMessage, saveThreadNoteForMessage } from "@/lib/email/thread-note";

type NoteRouteParams = { params: Promise<{ messageId: string }> };

const bodySchema = z.object({
	body: z.string().max(THREAD_NOTE_MAX_LENGTH),
});

async function reader(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	return { env, user };
}

export async function GET(request: Request, { params }: NoteRouteParams) {
	const { messageId } = await params;
	const { env, user } = await reader(request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const note = await getThreadNoteForMessage(env, user, messageId);
	if (note === "missing") return NextResponse.json({ error: "Message not found" }, { status: 404 });
	return NextResponse.json({ note });
}

export async function PUT(request: Request, { params }: NoteRouteParams) {
	const { messageId } = await params;
	const { env, user } = await reader(request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	let json: unknown;
	try {
		json = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid note" }, { status: 400 });
	}
	const parsed = bodySchema.safeParse(json);
	if (!parsed.success) {
		const tooLong = parsed.error.issues.some((issue) => issue.code === "too_big");
		return NextResponse.json({ error: tooLong ? "Note is too long" : "Invalid note" }, { status: 400 });
	}
	const note = await saveThreadNoteForMessage(env, user, messageId, parsed.data.body);
	if (note === "missing") return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if (note === "too-long") return NextResponse.json({ error: "Note is too long" }, { status: 400 });
	return NextResponse.json({ note });
}

export async function DELETE(request: Request, { params }: NoteRouteParams) {
	const { messageId } = await params;
	const { env, user } = await reader(request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const note = await saveThreadNoteForMessage(env, user, messageId, "");
	if (note === "missing") return NextResponse.json({ error: "Message not found" }, { status: 404 });
	return NextResponse.json({ note: null });
}
