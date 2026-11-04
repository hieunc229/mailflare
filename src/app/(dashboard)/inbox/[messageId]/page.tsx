"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Cloud, ExternalLink } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { markMessageRead } from "@/components/mark-read";
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
import { MessageDetailNavigation } from "@/components/messages/message-detail-navigation";
import { MessageReadingHeaderButton } from "@/components/messages/message-reading-header-button";
import { ScheduledSendBanner } from "@/components/messages/scheduled-send-banner";
import { formatScheduledSendTime } from "@/components/messages/scheduled-send-utils";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { ThreadMessageActions } from "@/components/messages/thread-message-actions";
import { MessageDetailsPanel } from "@/components/messages/message-details-panel";
import { SenderCheckNotice } from "@/components/messages/sender-check-notice";
import { useMessageThread } from "@/components/messages/use-message-thread";
import { useLatestMessagesFirst } from "@/components/messages/use-latest-messages-first";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { splitEmailAddressList } from "@/lib/email/address";
import { RecipientList } from "@/components/messages/recipient-list";
import { useShowFullRecipientAddresses } from "@/components/messages/use-show-full-recipient-addresses";
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
import { EmailHtmlRenderer } from "@/components/messages/email-html-renderer";
import { getEmailAddress } from "@/lib/email/address";
import { useRemoteContent } from "@/components/messages/use-remote-content";
import clsx from "clsx";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { useMessageContentScroll } from "./use-message-content-scroll";
import { useSendViewStatus } from "@/components/messages/use-send-view-status";

export default function MessageDetailPage() {
  const { t } = useLanguage();
  const params = useParams<{ messageId: string }>();
  const { selectedMailbox, mailboxes } = useSelectedMailbox();
  const messageId = params.messageId;
  useSendViewStatus(messageId);
  const [data, setData] = useState<MessageDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewAttachment, setPreviewAttachment] =
    useState<MessageAttachment | null>(null);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [latestMessagesFirst] = useLatestMessagesFirst();
  const { enabled: showFullRecipientAddresses } = useShowFullRecipientAddresses();
  const remote = useRemoteContent(
    data?.message ? getEmailAddress(data.message.fromAddr) : undefined,
    data?.message?.status === "spam",
  );
  const { visible: messageListVisible } = useMessageListVisibility();
  usePageLoading(loading);
  const thread = useMessageThread(messageId, data?.message?.threadId);
  const assistantVisible = useAssistantOpen();
  const isAnyPanelVisible = messageListVisible || assistantVisible;
  const { scrollRef, scrolled, handleScroll } = useMessageContentScroll(messageId, loading);

  useEffect(() => {
    let cancelled = false;

    async function loadMessage() {
      const cachedData = getCachedMessageDetailForDisplay(messageId);
      if (cachedData?.message && cachedData.body) {
        setData(cachedData);
        setLoading(false);
        if (!cachedData.message.read) void markMessageRead(cachedData.message.id);
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
      const nextData = await fetchMessageDetail(messageId).catch(() => fetchMessageDetail(messageId)).catch(() => ({ error: t("message.notFound") }));
      if (!cancelled) {
        setData(nextData);
        setLoading(false);
        if ("message" in nextData && nextData.message && !nextData.message.read) void markMessageRead(nextData.message.id);
      }
    }

    void loadMessage();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    setThreadExpanded(false);
    setDetailsOpen(false);
  }, [messageId]);

  // A bulk read/unread action can include the message that is already open.
  // Keep the mounted reader in sync with the cache instead of remounting it.
  useEffect(() => {
    function syncCachedReadState() {
      const cached = getCachedMessageDetailForDisplay(messageId);
      if (!cached?.message) return;
      const cachedRead = cached.message.read;
      setData((current) => {
        if (!current?.message || current.message.read === cachedRead) return current;
        return { ...current, message: { ...current.message, read: cachedRead } };
      });
    }
    window.addEventListener("mailflare:messages-changed", syncCachedReadState);
    return () => window.removeEventListener("mailflare:messages-changed", syncCachedReadState);
  }, [messageId]);

  if (loading) {
    return <MessageDetailSkeleton />;
  }

  if (!data?.message) {
    return (
      <p className="px-6 py-4 text-sm text-neutral-500">
        {data?.error ?? t("message.notFound")}
      </p>
    );
  }

  const { message, body, attachments = [], scheduledAt } = data;
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
  const { fromName, fromAddress } = getMessageHeaderParties(
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
  const htmlBody = (
    resolveInlineAttachmentUrls(bodyDisplay.htmlBody, message.id, attachments)
  );
  const quotedHtml = (
    resolveInlineAttachmentUrls(bodyDisplay.quotedHtml, message.id, attachments)
  );
  const cloudAttachmentResult = extractCloudAttachments(
    bodyDisplay.latestContent,
  );
  const messageDate = (withTime: boolean) => scheduledAt
    ? formatScheduledSendTime(scheduledAt, t)
    : formatUserDate(message.createdAt, withTime
      ? { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "2-digit", year: "numeric" });
  return (<>

    <div className={clsx("flex py-2 h-12 items-center px-2 border-b sticky top-0 bg-white z-40 gap-3", scrolled ? "border-neutral-200" : "border-transparent")}>
      <MessageReadingHeaderButton assistantVisible={assistantVisible} />
      {/* <div className="min-w-0 flex-1" /> */}
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
      <MessageDetailNavigation messageId={message.id} unread={message.direction === "inbound" && !message.read} />
    </div>

    <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto overscroll-contain scrollbar-gutter-stable flex-1 min-h-0">
      <h1 className={clsx(!isAnyPanelVisible ? "sm:pl-16" : "sm:pl-10", "px-4 pb-2 pt-2 text-2xl text-neutral-900 sm:pr-6")} title={message.subject ?? t("list.noSubject")}>
        {message.subject ?? t("list.noSubject")}
      </h1>
      {/* <div className="px-6">
        <div className="mx-auto w-full max-w-[640px]">
          <SpamScoreDetails
            score={message.spamScore}
            verdict={message.spamVerdict}
            signals={message.spamSignals}
            analysisError={message.spamAnalysisError}
          />
        </div>
      </div> */}
      <ConversationThread
        currentMessageId={message.id}
        position={latestMessagesFirst ? "after" : "before"}
        messages={thread.messages}
        mailboxId={message.mailboxId}
        currentAccountName={currentAccountName}
        ownAddress={ownAddress}
        ownAddresses={ownAddresses}
        latestMessagesFirst={latestMessagesFirst}
        showFullRecipientAddresses={showFullRecipientAddresses}
        expandedAll={threadExpanded}
        onExpandedAllChange={setThreadExpanded}
      />
      <article className={clsx("py-4 sm:px-6", !isAnyPanelVisible && "sm:pl-12")}>
        <div className="w-full">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pb-5 sm:px-0 sm:pl-4">
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
                  <span className="hidden sm:block text-neutral-500 text-xs flex-1 overflow-hidden text-ellipsis min-w-0">&lt;{fromAddress}&gt;</span>
                </p>
                <p className="text-xs text-neutral-500">
                  {t("source.to").toLowerCase()}{" "}
                  <RecipientList
                    entries={toEntries}
                    mailboxId={message.mailboxId}
                    style={showFullRecipientAddresses ? "full" : "address"}
                  />
                </p>
                <div className="sm:hidden flex items-center gap-2 text-xs text-neutral-500">
                  <span>{messageDate(false)}</span>
                </div>
                {ccEntries.length > 0 && (
                  <p className="text-xs text-neutral-500">
                    {t("message.cc")} <RecipientList entries={ccEntries} mailboxId={message.mailboxId} style={showFullRecipientAddresses ? "full" : "address"} />
                  </p>
                )}
                {bccEntries.length > 0 && (
                  <p className="text-xs text-neutral-500">
                    {t("message.bcc")} <RecipientList entries={bccEntries} mailboxId={message.mailboxId} style={showFullRecipientAddresses ? "full" : "address"} />
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <p className="hidden text-xs sm:block">{messageDate(true)}</p>
              <ThreadMessageActions
                message={currentThreadMessage}
                mailboxId={message.mailboxId}
                ownAddress={ownAddress}
                ownAddresses={ownAddresses}
                starOnly={!thread.messages.some((threadMessage) => threadMessage.id === message.id) || !thread.messages.some((threadMessage) => threadMessage.id !== message.id)}
                detailsOpen={detailsOpen}
                onToggleDetails={() => setDetailsOpen((open) => !open)}
              />
            </div>
          </div>
          <div className="mb-4 px-4 sm:px-0 sm:pl-4 sm:pr-4">
            <SenderCheckNotice
              message={message}
              detailsOpen={detailsOpen}
              onViewDetails={() => setDetailsOpen((open) => !open)}
              announce
            />
          </div>
          {detailsOpen && (
            <div className="mb-4 px-4 sm:px-0 sm:pl-4 sm:pr-4">
              <MessageDetailsPanel message={message} onClose={() => setDetailsOpen(false)} />
            </div>
          )}
          {scheduledAt && <div className="px-4 sm:px-0 sm:pl-10"><ScheduledSendBanner messageId={message.id} scheduledAt={scheduledAt} /></div>}
          <div className="prose max-w-none px-4 text-neutral-900 sm:px-0 sm:pl-16">
            {htmlBody ? (
              <EmailHtmlRenderer key={message.id} className="mx-auto" html={htmlBody} autoAllowRemote={remote.autoAllow} onAllowRemote={remote.allowSender} />
            ) : (
              <pre className="whitespace-pre-wrap text-sm text mx-auto">
                {cloudAttachmentResult.content}
              </pre>
            )}
            {quotedHtml && <QuotedEmailToggle html={quotedHtml} autoAllowRemote={remote.autoAllow} onAllowRemote={remote.allowSender} />}
            {bodyDisplay.quotedContent.map((quotedContent) => (
              <PreviousMessage
                key={`${quotedContent.dateLine}-${quotedContent.content.slice(0, 24)}`}
                message={quotedContent}
              />
            ))}
          </div>
          {cloudAttachmentResult.attachments.length > 0 && (
            <section className="mt-8 border-t border-neutral-100 px-4 py-6 sm:px-0 sm:pl-16">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                {t("message.cloudFiles", { count: cloudAttachmentResult.attachments.length })}
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
                        {t("message.openFrom", { provider: attachment.provider })}
                      </span>
                    </span>
                    <ExternalLink className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
                    <span className="sr-only"> ({t("common.opensInNewTab")})</span>
                  </a>
                ))}
              </div>
            </section>
          )}
          {attachments.length > 0 && (
            <section className="mt-8 border-t border-neutral-100 px-4 py-6 sm:px-0 sm:pl-16">
              <h2 className="mb-3 text-sm font-semibold text-neutral-900">
                {t("message.attachments", { count: attachments.length })}
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
        </div>
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
        showFullRecipientAddresses={showFullRecipientAddresses}
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
  </>
  );
}
