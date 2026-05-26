import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import dayjs from "dayjs";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getMessageWithBody } from "@/lib/email/inbound";
import { MarkAsRead } from "@/components/mark-read";
import { MessageActions } from "@/components/message-actions/message-actions";
import { getMessageBackHref } from "@/components/message-actions/utils";

export default async function MessageDetailPage({
  params,
}: {
  params: Promise<{ messageId: string }>;
}) {
  const { messageId } = await params;
  const env = getEnv();
  const user = await getCurrentUser(env);
  if (!user) redirect("/login");

  const data = await getMessageWithBody(env, user.id, messageId);
  if (!data) notFound();

  const { message, body } = data;

  return (
    <div className="h-full overflow-auto">
      {message.direction === "inbound" && !message.read && (
        <MarkAsRead messageId={message.id} />
      )}
      <div className="flex py-2 items-center justify-between px-2">
        <div className="flex items-center flex-row gap-6">
          <Link
            href={getMessageBackHref(message.direction, message.status)}
            className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          {/* <Badge>{message.direction}</Badge> */}
          {/* <Badge variant="outline">{message.status}</Badge> */}
        </div>
        <MessageActions
          messageId={message.id}
          direction={message.direction}
          status={message.status}
        />
      </div>
      <article className="px-6">
        <h1 className="text-2xl text-neutral-900 mb-4">
          {message.subject ?? "(no subject)"}
        </h1>

        <div className="mb-6 flex items-start justify-between border-b border-neutral-100 pb-5">
          <div>
            <p className="text-sm font-semibold text-neutral-900">
              {message.fromAddr}
            </p>
            <p className="text-xs text-neutral-500">to {message.toAddr}</p>
          </div>
          <p className="text-xs text-neutral-400">
            {dayjs(message.createdAt).format("MMM DD, YYYY, hh:mmA")}
          </p>
        </div>
        <div className="prose max-w-none text-neutral-900">
          {body?.htmlBody ? (
            <div dangerouslySetInnerHTML={{ __html: body.htmlBody }} />
          ) : (
            <pre className="whitespace-pre-wrap text-sm">
              {body?.textBody ?? message.snippet}
            </pre>
          )}
        </div>
      </article>
    </div>
  );
}
