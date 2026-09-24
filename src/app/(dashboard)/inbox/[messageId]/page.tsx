"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Cloud, ExternalLink } from "lucide-react";
import dayjs from "dayjs";
import { MarkAsRead } from "@/components/mark-read";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { ContactDetailsTrigger } from "@/components/contacts/contact-details";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { MessageActions } from "@/components/message-actions/message-actions";
import { MessageAttachmentViewer } from "@/components/message-attachment-viewer";
import { MessageAttachmentCard } from "@/components/message-attachment-card";
import { MessageDetailSkeleton } from "@/components/page-skeletons";
import { usePageLoading } from "@/components/page-loading";
import { PreviousMessage } from "@/components/previous-message";
import { ConversationThread } from "@/components/messages/conversation-thread";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { ThreadMessageActions } from "@/components/messages/thread-message-actions";
import { SpamScoreDetails } from "@/components/messages/spam-score-details";
import { useMessageThread } from "@/components/messages/use-message-thread";
import { useLatestMessagesFirst } from "@/components/messages/use-latest-messages-first";
import { getMessageBackHref } from "@/components/message-actions/utils";
import { getEmailAddress, getEmailDisplayName, splitEmailAddressList } from "@/lib/email/address";
import type { MessageAttachment, MessageDetailResponse } from "./types";
import {
  fetchMessageDetail,
  fetchMessageMetadata,
  getCachedMessageDetailForDisplay,
  getMessageBodyDisplay,
  getMessageHeaderParties,
  getOwnAddressForMessage,
  resolveInlineAttachmentUrls,
} from "./utils";
import { extractCloudAttachments } from "./cloud-attachment-utils";
import { sanitizeEmailHtml } from "./email-html-sanitizer";
import { collapseQuotedEmailHtml } from "./quote-collapse-utils";

export default function MessageDetailPage() {
  const params = useParams<{ messageId: string }>();
  const { selectedMailbox, mailboxes } = useSelectedMailbox();
  const messageId = params.messageId;
  const [data, setData] = useState<MessageDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewAttachment, setPreviewAttachment] =
    useState<MessageAttachment | null>(null);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [latestMessagesFirst] = useLatestMessagesFirst();
  usePageLoading(loading);
  const thread = useMessageThread(messageId, data?.message?.threadId);

  useEffect(() => {
    let cancelled = false;

    async function loadMessage() {
      const cachedData = getCachedMessageDetailForDisplay(messageId);
      if (cachedData?.message && cachedData.body) {
        setData(cachedData);
        setLoading(false);
        if (cachedData.attachments !== undefined) return;
        try {
          const metadata = await fetchMessageMetadata(messageId);
          if (!cancelled) setData((current) => current ? { ...current, ...metadata } : current);
        } catch {
          // The message body remains usable if supplemental metadata is unavailable.
        }
        return;
      }
      setLoading(true);
      const nextData = await fetchMessageDetail(messageId);
      if (!cancelled) {
        setData(nextData);
        setLoading(false);
      }
    }

    void loadMessage();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    setThreadExpanded(false);
  }, [messageId]);

  if (loading) {
    return <MessageDetailSkeleton />;
  }

  if (!data?.message) {
    return (
      <p className="px-6 py-4 text-sm text-neutral-500">
        {data?.error ?? "Message not found"}
      </p>
    );
  }

  const { message, body, attachments = [] } = data;
  const currentThreadMessage = {
    ...message,
    textBody: body?.textBody ?? null,
    htmlBody: body?.htmlBody ?? null,
    attachments,
  };
  const messageMailbox =
    mailboxes.find((mailbox) => mailbox.id === message.mailboxId) ?? selectedMailbox;
  const currentAccountName =
    messageMailbox?.displayName ?? messageMailbox?.localPart;
  const { fromName, fromAddress, toName } = getMessageHeaderParties(
    message,
    currentAccountName,
  );
  const ownAddresses = messageMailbox
    ? messageMailbox.senderAddresses?.length
      ? messageMailbox.senderAddresses
      : [`${messageMailbox.localPart}@${messageMailbox.hostname}`]
    : [];
  const ownAddress = getOwnAddressForMessage(message, ownAddresses);
  const toEntries = splitEmailAddressList(message.toAddr);
  const ccEntries = splitEmailAddressList(message.ccAddr);
  const bccEntries = splitEmailAddressList(message.bccAddr);
  const bodyDisplay = getMessageBodyDisplay(
    body?.textBody,
    body?.htmlBody,
    message.snippet,
    ownAddress,
  );
  const htmlBody = collapseQuotedEmailHtml(sanitizeEmailHtml(
    resolveInlineAttachmentUrls(bodyDisplay.htmlBody, message.id, attachments),
  ));
  const quotedHtml = collapseQuotedEmailHtml(sanitizeEmailHtml(
    resolveInlineAttachmentUrls(bodyDisplay.quotedHtml, message.id, attachments),
  ), true);
  const cloudAttachmentResult = extractCloudAttachments(
    bodyDisplay.latestContent,
  );
  return (
    <div className="h-full overflow-y-auto overscroll-contain scrollbar-gutter-stable">
      {!message.read && <MarkAsRead messageId={message.id} />}
      <div className="flex pt-3 pb-2.75 items-center justify-between px-2 border-b border-neutral-200 sticky top-0 bg-white z-40">
        <div className="flex-1" />
        {/* <div className="flex items-center flex-row gap-6">
					<Link
						href={getMessageBackHref(message.direction, message.status)}
						className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100"
					>
						<ArrowLeft className="h-5 w-5" />
					</Link>
				</div> */}
        <MessageActions
          messageId={message.id}
          mailboxId={message.mailboxId}
          senderAddress={message.fromAddr}
          direction={message.direction}
          status={message.status}
          read={message.read}
          unsubscribeUrl={data.unsubscribeUrl}
          subject={message.subject}
          bodyText={body?.textBody}
          ownAddress={ownAddress}
          ownAddresses={ownAddresses}
          message={message}
          messageMeta={message}
          bodyHtml={body?.htmlBody}
        />
      </div>
      <div className="px-6 pb-2 pt-4">
        <h1 className="text-2xl text-neutral-900">
          {message.subject ?? "(no subject)"}
        </h1>
      </div>
      <SpamScoreDetails
        score={message.spamScore}
        verdict={message.spamVerdict}
        signals={message.spamSignals}
        analysisError={message.spamAnalysisError}
      />
      <ConversationThread
        currentMessageId={message.id}
        position={latestMessagesFirst ? "after" : "before"}
        messages={thread.messages}
        mailboxId={message.mailboxId}
        currentAccountName={currentAccountName}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        latestMessagesFirst={latestMessagesFirst}
        expandedAll={threadExpanded}
        onExpandedAllChange={setThreadExpanded}
      />
      <article className="px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 pb-5">
          <div className="flex min-w-0 items-start gap-3">
            <ContactAvatar
              mailboxId={message.mailboxId}
              address={message.fromAddr}
              name={fromName}
              hasManagedAvatar={message.direction === "inbound"}
              managedAvatarUrl={message.direction === "outbound" && message.mailboxId
                ? `/api/mailboxes/${message.mailboxId}/avatar`
                : undefined}
              className="mt-2"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-neutral-900 mt-1.25 flex flex-row items-center gap-1 w-full  overflow-hidden">
                <b className="whitespace-nowrap">
                  {message.direction === "inbound" ? (
                    <ContactDetailsTrigger
                      mailboxId={message.mailboxId}
                      address={message.fromAddr}
                      name={fromName}
                    />
                  ) : (
                    fromName
                  )}
                </b>{" "}
                <span className="text-neutral-500 text-xs flex-1 overflow-hidden text-ellipsis min-w-0">&lt;{fromAddress}&gt;</span>
              </p>
              <p className="text-xs text-neutral-500">
                to{" "}
                {message.direction === "inbound" && toEntries.length <= 1 ? (
                  toName
                ) : (
                  <RecipientList
                    entries={toEntries}
                    mailboxId={message.mailboxId}
                    firstName={message.direction === "outbound" ? toName : undefined}
                  />
                )}
              </p>
              {ccEntries.length > 0 && (
                <p className="text-xs text-neutral-500">
                  cc <RecipientList entries={ccEntries} mailboxId={message.mailboxId} />
                </p>
              )}
              {bccEntries.length > 0 && (
                <p className="text-xs text-neutral-500">
                  bcc <RecipientList entries={bccEntries} mailboxId={message.mailboxId} />
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <p className="text-xs">
              {dayjs(message.createdAt).format("MMM DD, YYYY, hh:mmA")}
            </p>
            <ThreadMessageActions
              message={currentThreadMessage}
              mailboxId={message.mailboxId}
              ownAddress={ownAddress}
              ownAddresses={ownAddresses}
            />
          </div>
        </div>
        <div className="prose max-w-none text-neutral-900">
          {htmlBody ? (
            <div className="email-body mx-auto" dangerouslySetInnerHTML={{ __html: htmlBody }} />
          ) : (
            <pre className="whitespace-pre-wrap text-sm text mx-auto">
              {cloudAttachmentResult.content}
            </pre>
          )}
          {quotedHtml && <QuotedEmailToggle html={quotedHtml} />}
          {bodyDisplay.quotedContent.map((quotedContent) => (
            <PreviousMessage
              key={`${quotedContent.dateLine}-${quotedContent.content.slice(0, 24)}`}
              message={quotedContent}
            />
          ))}
        </div>
        {cloudAttachmentResult.attachments.length > 0 && (
          <section className="mt-8 border-t border-neutral-100 py-6">
            <h2 className="mb-3 text-sm font-semibold text-neutral-900">
              Cloud files ({cloudAttachmentResult.attachments.length})
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {cloudAttachmentResult.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={attachment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 text-left hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <Cloud className="h-5 w-5 shrink-0 text-blue-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-neutral-900">
                      {attachment.filename}
                    </span>
                    <span className="block text-xs text-neutral-500">
                      Open from {attachment.provider}
                    </span>
                  </span>
                  <ExternalLink className="h-4 w-4 shrink-0 text-neutral-400" />
                </a>
              ))}
            </div>
          </section>
        )}
        {attachments.length > 0 && (
          <section className="mt-8 border-t border-neutral-100 py-6">
            <h2 className="mb-3 text-sm font-semibold text-neutral-900">
              Attachments ({attachments.length})
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {attachments.map((attachment) => (
                <MessageAttachmentCard
                  key={attachment.id}
                  attachment={attachment}
                  messageId={message.id}
                  onPreview={setPreviewAttachment}
                />
              ))}
            </div>
          </section>
        )}
      </article>
      <ConversationThread
        currentMessageId={message.id}
        position={latestMessagesFirst ? "before" : "after"}
        messages={thread.messages}
        mailboxId={message.mailboxId}
        currentAccountName={currentAccountName}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        latestMessagesFirst={latestMessagesFirst}
        expandedAll={threadExpanded}
        onExpandedAllChange={setThreadExpanded}
      />
      <MessageAttachmentViewer
        attachment={previewAttachment}
        messageId={message.id}
        open={previewAttachment !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewAttachment(null);
        }}
      />
    </div>
  );
}

function RecipientList({
  entries,
  mailboxId,
  firstName,
}: {
  entries: string[];
  mailboxId: string | null;
  /** A contact name already resolved for the first entry, when the caller has one. */
  firstName?: string;
}) {
  if (entries.length === 0) return <>—</>;
  return (
    <>
      {entries.map((entry, index) => (
        <span key={entry} title={getEmailAddress(entry)}>
          {index > 0 && ", "}
          <ContactDetailsTrigger
            mailboxId={mailboxId}
            address={entry}
            name={index === 0 && firstName ? firstName : getEmailDisplayName(entry)}
          />
        </span>
      ))}
    </>
  );
}
