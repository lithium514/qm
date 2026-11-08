import { feishuConversationRef } from "../loops/sources/feishu.ts";
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import { buffer } from "node:stream/consumers";
import { GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";
import type { ActorAssertion, IncomingAttachment, TurnRequest } from "../types.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import { audienceFromMembers, listChatMembers, type FeishuChatMember, type FeishuClient } from "./directory.ts";
import type { FeishuPluginConfig } from "./config.ts";
import type { FeishuCore } from "./core.ts";
import {
  feishuContainerRef,
  feishuConversationKind,
  feishuDeliveryTarget,
  feishuThreadRef,
  type FeishuRef,
} from "./ids.ts";
import type { FeishuHistory } from "./history.ts";
import { messageToIngest } from "./mirror.ts";
import { parseQmAction, type FeishuCardAction } from "./payloads.ts";
import { createFeishuApprovalHandler, createFeishuDeployHandler, createFeishuKeychainHandler } from "./approval.ts";

const MAX_INBOUND_FILES = 10;
const MAX_INBOUND_FILE_BYTES = 30 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

function resourceName(resource: ResourceDescriptor): string {
  if (resource.fileName) return resource.fileName;
  const extension = resource.type === "image" ? "png" : "bin";
  return `${resource.type}-${resource.fileKey}.${extension}`;
}

function senderIsBot(message: NormalizedMessage, botOpenId: string | undefined): boolean {
  if (botOpenId && message.senderId === botOpenId) return true;
  const raw = message.raw as { sender?: { sender_type?: string } } | undefined;
  return raw?.sender?.sender_type === "app";
}

function sendOptions(target: FeishuRef): { replyTo: string; replyInThread: boolean } | undefined {
  return target.threadId ? { replyTo: target.threadId, replyInThread: true } : undefined;
}

export interface FeishuMessageHandlerDeps {
  config: FeishuPluginConfig;
  core: FeishuCore;
  channel: Pick<LarkChannel, "downloadResource" | "send"> & {
    botIdentity?: { openId: string };
    rawClient?: FeishuClient;
  };
  readHistory?: (request: {
    chatId: string;
    threadId?: string;
    beforeTs: string;
    isDirect: boolean;
  }) => Promise<FeishuHistory>;
}

async function downloadInboundResource(
  deps: FeishuMessageHandlerDeps,
  messageId: string,
  resource: ResourceDescriptor,
): Promise<Buffer> {
  const type = resource.type === "image" ? "image" : "file";
  const messageResource = deps.channel.rawClient?.im.v1.messageResource;
  if (messageResource) {
    const response = await messageResource.get({
      path: { message_id: messageId, file_key: resource.fileKey },
      params: { type },
    });
    return buffer(response.getReadableStream());
  }
  return deps.channel.downloadResource(resource.fileKey, type);
}

async function stageAttachments(
  deps: FeishuMessageHandlerDeps,
  message: NormalizedMessage,
): Promise<{ attachments: IncomingAttachment[]; notes: string[] }> {
  const attachments: IncomingAttachment[] = [];
  const notes: string[] = [];
  for (const resource of message.resources.slice(0, MAX_INBOUND_FILES)) {
    const name = resourceName(resource);
    try {
      const bytes = await downloadInboundResource(deps, message.messageId, resource);
      if (bytes.length > MAX_INBOUND_FILE_BYTES) {
        notes.push(`${name} is larger than ${Math.round(MAX_INBOUND_FILE_BYTES / (1024 * 1024))} MB and was skipped`);
        continue;
      }
      const staged = await deps.core.stageBlob(bytes);
      attachments.push({
        name,
        mimetype: mimeTypeForName(name),
        sizeBytes: bytes.length,
        blobId: staged.blobId,
        sourceId: resource.fileKey,
        ...(message.senderName ? { author: message.senderName } : {}),
      });
    } catch (error) {
      notes.push(`${name} could not be read: ${errMessage(error)}`);
    }
  }
  if (message.resources.length > MAX_INBOUND_FILES) {
    notes.push(`only the first ${MAX_INBOUND_FILES} files were read`);
  }
  return { attachments, notes };
}

const MEMBER_CACHE_TTL_MS = 60_000;
const MEMBER_CACHE_MAX = 1_000;

export function createFeishuMessageHandler(
  deps: FeishuMessageHandlerDeps,
): (message: NormalizedMessage) => Promise<void> {
  const memberCache = new Map<string, { at: number; members: FeishuChatMember[] }>();
  const audienceFor = async (message: NormalizedMessage, actor: ActorAssertion): Promise<ActorAssertion[]> => {
    if (message.chatType === "p2p" || !deps.channel.rawClient) return [actor];
    const cached = memberCache.get(message.chatId);
    if (cached && Date.now() - cached.at < MEMBER_CACHE_TTL_MS)
      return audienceFromMembers(cached.members, actor, message.senderId);
    try {
      const members = await listChatMembers(deps.channel.rawClient, message.chatId);
      if (memberCache.size >= MEMBER_CACHE_MAX) memberCache.clear();
      memberCache.set(message.chatId, { at: Date.now(), members });
      return audienceFromMembers(members, actor, message.senderId);
    } catch (error) {
      reportFailure("feishu: chat members", error, `chat=${message.chatId}`);
      return [actor];
    }
  };
  return async (message) => {
    const botOpenId = deps.channel.botIdentity?.openId;
    try {
      await deps.core.ingestSurfaceEvents?.([messageToIngest(message, botOpenId)], {
        ...(deps.config.botName ? { name: deps.config.botName } : {}),
        ...(botOpenId ? { mentionId: botOpenId } : {}),
      });
    } catch (error) {
      reportFailure("feishu: mirror", error, `chat=${message.chatId}`);
    }
    if (senderIsBot(message, botOpenId)) return;
    const isDirect = message.chatType === "p2p";
    const threadId = isDirect ? undefined : (message.rootId ?? message.threadId ?? message.messageId);
    try {
      await deps.core.inboxEvent?.({
        source: "feishu",
        conversationRef: feishuConversationRef(message.chatId, message.messageId, threadId, isDirect),
        at: message.createTime,
        ...(message.content ? { text: message.content } : {}),
        senderId: deps.core.resolvePrincipal?.(message.senderId) ?? message.senderId,
      });
    } catch (error) {
      reportFailure("feishu: inbox", error, `chat=${message.chatId}`);
    }
    let addressed = isDirect || message.mentionedBot;
    if (!addressed) {
      if (!threadId || !(await deps.core.hasSession?.(feishuThreadRef(message.chatId, threadId)))) return;
      addressed = true;
    }
    const target: FeishuRef = { chatId: message.chatId, ...(threadId ? { threadId } : {}) };
    const actor = {
      externalId: message.senderId,
      ...(message.senderName ? { displayName: message.senderName } : {}),
    };
    void deps.core
      .upsertMember?.({
        principalId: actor.externalId,
        displayName: actor.displayName ?? actor.externalId,
        type: "internal",
      })
      .catch(() => undefined);
    let history: FeishuHistory | undefined;
    if (deps.readHistory) {
      try {
        history = await deps.readHistory({
          chatId: message.chatId,
          ...(threadId ? { threadId } : {}),
          beforeTs: message.messageId,
          isDirect,
        });
      } catch (error) {
        reportFailure("feishu: history", error, `chat=${message.chatId}`);
      }
    }
    const { attachments, notes } = await stageAttachments(deps, message);
    const request: TurnRequest = {
      surface: "feishu",
      actor,
      conversation: {
        kind: feishuConversationKind(message.chatType),
        threadRef: feishuThreadRef(message.chatId, threadId),
        channelRef: feishuContainerRef(message.chatId),
        audience: await audienceFor(message, actor),
        ...(isDirect ? { isPrivate: true } : {}),
      },
      deliveryTarget: feishuDeliveryTarget(message.chatId, threadId),
      text: message.content,
      origin: { kind: "human", messageTs: message.messageId },
      addressed,
      redeliveryKey: `feishu:${deps.config.appId}:${message.messageId}`,
      async: true,
      ...(history?.priorTurns.length ? { priorTurns: history.priorTurns } : {}),
      ...(history?.overheard.length ? { overheard: history.overheard } : {}),
      ...(history?.conversationHeader ? { conversationHeader: history.conversationHeader } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(notes.length ? { inboundNotes: notes } : {}),
    };
    try {
      await deps.core.turn(request);
    } catch (error) {
      await deps.channel
        .send(target.chatId, { markdown: GENERIC_FAILURE_TEXT }, sendOptions(target))
        .catch(() => undefined);
      throw error;
    }
  };
}

export interface FeishuCardResponse {
  toast?: { type: "info" | "success" | "error"; content: string };
  card?: object;
}

export function createFeishuCardHandler(deps: {
  core: FeishuCore;
}): (action: FeishuCardAction) => Promise<FeishuCardResponse | undefined> {
  const approval = createFeishuApprovalHandler({ core: deps.core });
  const keychain = createFeishuKeychainHandler({ core: deps.core });
  const deploy = createFeishuDeployHandler({ core: deps.core });
  return async (action) => {
    const parsed = parseQmAction(action.value);
    if (!parsed) return undefined;
    if (parsed.action === "approval") return approval(action, parsed);
    if (parsed.action === "keychain") return keychain(action, parsed);
    if (parsed.action === "deploy") return deploy(action, parsed);
    return { toast: { type: "info", content: `Received ${parsed.action}` } };
  };
}
