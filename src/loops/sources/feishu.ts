import * as lark from "@larksuiteoapi/node-sdk";
import type { LoopItem, LoopSourcePayload } from "../types.ts";
import { errMessage } from "../../util/errors.ts";
import {
  clip,
  clipOpt,
  draftOf,
  isObj,
  parseCommonFields,
  parseReplyDraft,
  tokenFor,
  type FeishuUserClient,
  type LoopSourceAdapter,
  type ParsedEntry,
  type ReplyDraft,
  type SourceActionDeps,
  type SourceActionResult,
} from "./adapter.ts";

const FEISHU_HOST = "open.feishu.cn";

interface FeishuMeta {
  chatId: string;
  chatLabel?: string;
  messageId: string;
  threadId?: string;
  isDirectMessage?: boolean;
  userId?: string;
}

function parseFeishuMeta(v: unknown): FeishuMeta | undefined {
  if (!isObj(v)) return undefined;
  const chatId = clip(v.chatId, 80);
  const messageId = clip(v.messageId, 80);
  if (!chatId || !messageId) return undefined;
  const chatLabel = clipOpt(v.chatLabel, 120);
  const threadId = clipOpt(v.threadId, 80);
  const userId = clipOpt(v.userId, 80);
  return {
    chatId,
    messageId,
    ...(chatLabel ? { chatLabel } : {}),
    ...(threadId ? { threadId } : {}),
    ...(userId ? { userId } : {}),
    ...(typeof v.isDirectMessage === "boolean" ? { isDirectMessage: v.isDirectMessage } : {}),
  };
}

function metaOf(item: LoopItem): FeishuMeta | undefined {
  return parseFeishuMeta(item.sourcePayload?.feishu);
}

export function feishuConversationRef(
  chatId: string,
  messageId: string,
  threadId: string | undefined,
  isDirectMessage: boolean,
): string {
  return isDirectMessage && !threadId ? chatId : `${chatId}:${threadId ?? messageId}`;
}

export function feishuReplyMessageId(item: LoopItem): string | undefined {
  const feishu = metaOf(item);
  if (!feishu) return undefined;
  return feishu.threadId ?? (feishu.isDirectMessage ? undefined : feishu.messageId);
}

function itemReactions(item: LoopItem): string[] {
  const raw = item.sourcePayload?.reactions;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
}

export function normalizeFeishuReaction(raw: string): string | null {
  const name = raw.trim().replace(/^:|:$/g, "");
  if (!name) return null;
  const aliases: Record<string, string> = {
    "+1": "THUMBSUP",
    thumbsup: "THUMBSUP",
    "-1": "THUMBSDOWN",
    thumbsdown: "THUMBSDOWN",
    heart: "HEART",
    eyes: "EYES",
    ok: "OK",
    tada: "PARTY",
    smile: "SMILE",
    laughing: "LAUGH",
    joy: "LAUGH",
    fire: "FIRE",
    clap: "CLAP",
  };
  const lower = name.toLowerCase();
  if (aliases[lower]) return aliases[lower]!;
  return /^[A-Z][A-Z0-9_]*$/.test(name) ? name : null;
}

export function feishuUserClientFactory(appId: string, appSecret: string): (token: string) => FeishuUserClient {
  return (token) => {
    if (!appId || !appSecret) throw new Error("Feishu app credentials are not configured");
    const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild });
    const options = lark.withUserAccessToken(token);
    return {
      async send(chatId, text) {
        await client.im.v1.message.create(
          {
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
          },
          options,
        );
      },
      async reply(messageId, text) {
        await client.im.v1.message.reply(
          {
            path: { message_id: messageId },
            data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: true },
          },
          options,
        );
      },
      async react(messageId, emoji) {
        await client.im.v1.messageReaction.create(
          { path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } },
          options,
        );
      },
    };
  };
}

async function clientAsUser(deps: SourceActionDeps): Promise<FeishuUserClient | null> {
  const token = await tokenFor(deps.tokens, FEISHU_HOST, deps.owner);
  if (!token || !deps.feishuClient) return null;
  return deps.feishuClient(token);
}

const notConnected: SourceActionResult = {
  ok: false,
  reason: "not_connected",
  message: "Feishu is not connected for this account",
};

async function sendFeishu(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const feishu = metaOf(item);
  if (!feishu?.chatId) return { ok: false, reason: "bad_item", message: "item carries no Feishu chat" };
  const client = await clientAsUser(deps);
  if (!client) return notConnected;
  const body = draft.body.trim();
  const replyId = feishuReplyMessageId(item);
  if (replyId) await client.reply(replyId, body);
  else await client.send(feishu.chatId, body);
  return { ok: true, result: body };
}

async function reactInFeishu(deps: SourceActionDeps, item: LoopItem, raw: unknown): Promise<SourceActionResult> {
  const feishu = metaOf(item);
  if (!feishu?.messageId) return { ok: false, reason: "bad_item", message: "item carries no Feishu message" };
  const name = typeof raw === "string" ? normalizeFeishuReaction(raw) : null;
  if (!name) return { ok: false, reason: "bad_item", message: "name (a Feishu emoji type) required" };
  const client = await clientAsUser(deps);
  if (!client) return notConnected;
  await client.react(feishu.messageId, name);
  return {
    ok: true,
    result: `:${name}:`,
    resolves: false,
    payloadPatch: { reactions: [...new Set([...itemReactions(item), name])] } as LoopSourcePayload,
  };
}

export const feishuAdapter: LoopSourceAdapter = {
  id: "feishu",
  actions: ["send", "react"],
  parse(raw) {
    const common = parseCommonFields(raw);
    if ("error" in common) return common;
    const rawKey = clip(raw.sourceKey ?? raw.dedupeKey, 300);
    if (!rawKey) return { error: "sourceKey required" };
    const feishu = parseFeishuMeta(raw.feishu);
    if (!feishu || feishu.isDirectMessage === undefined)
      return { error: "feishu items need feishu.chatId, feishu.messageId and feishu.isDirectMessage" };
    const dedupeKey = feishuConversationRef(feishu.chatId, feishu.messageId, feishu.threadId, feishu.isDirectMessage);
    const draft = raw.draft === undefined ? undefined : parseReplyDraft(raw.draft);
    if (draft === null) return { error: "draft needs a string body" };
    const entry: ParsedEntry = {
      dedupeKey,
      summary: common.snippet,
      sourceAt: common.receivedAt,
      sourcePayload: { source: "feishu", ...common, feishu } as LoopSourcePayload,
      ...(draft ? { proposal: { data: draft as unknown as LoopSourcePayload } } : {}),
    };
    return entry;
  },
  matchesEvent(item, conversationRef) {
    const feishu = metaOf(item);
    if (!feishu) return false;
    return (feishu.isDirectMessage ? [true, false] : [false]).some(
      (dm) => feishuConversationRef(feishu.chatId, feishu.messageId, feishu.threadId, dm) === conversationRef,
    );
  },
  parseProposal(raw) {
    const draft = parseReplyDraft(raw);
    return draft ? (draft as unknown as LoopSourcePayload) : null;
  },
  async act(deps, item, kind, args) {
    if (kind !== "send" && kind !== "react") {
      return { ok: false, reason: "bad_item", message: `feishu items do not support "${kind}"` };
    }
    try {
      if (kind === "react") return await reactInFeishu(deps, item, args.name);
      const draft = args.body !== undefined ? parseReplyDraft(args) : draftOf(item);
      if (!draft || !draft.body.trim()) return { ok: false, reason: "bad_item", message: "the draft is empty" };
      return await sendFeishu(deps, item, { ...draft, body: draft.body.trim() });
    } catch (err) {
      return { ok: false, reason: "upstream", message: errMessage(err) };
    }
  },
};
