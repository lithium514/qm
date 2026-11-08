import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { IngestEvent } from "../surface-cache/types.ts";

export function messageToIngest(message: NormalizedMessage, botOpenId?: string): IngestEvent {
  const self = !!botOpenId && message.senderId === botOpenId;
  const raw = message.raw as { sender?: { sender_type?: string } } | undefined;
  const bot = self || raw?.sender?.sender_type === "app";
  const sub = message.rootId ?? message.threadId;
  const mentions = message.mentions.length
    ? Object.fromEntries(message.mentions.map((mention) => [mention.key, mention.openId ?? mention.name ?? ""]))
    : undefined;
  const files = message.resources.length
    ? message.resources.map((resource) => ({
        fileId: resource.fileKey,
        ...(resource.fileName ? { name: resource.fileName } : {}),
      }))
    : undefined;
  return {
    container: message.chatId,
    ts: message.messageId,
    ...(sub ? { sub } : {}),
    authorId: message.senderId,
    ...(message.senderName ? { authorName: message.senderName } : {}),
    text: message.content,
    ...(mentions ? { mentions } : {}),
    ...(self ? { self: true } : {}),
    ...(bot ? { bot: true } : {}),
    mentionsSelf: message.mentionedBot,
    createdAt: message.createTime,
    ...(files ? { files } : {}),
    kind: message.chatType === "p2p" ? "dm" : "channel",
  };
}
