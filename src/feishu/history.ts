import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { CachedMessage, ReadMessagesOpts } from "../surface-cache/types.ts";
import type { ConversationTurn, OverheardMessage } from "../types.ts";
import type { FeishuCore } from "./core.ts";
import { feishuMessageText } from "./payloads.ts";
import { reportFailureAs } from "../util/errors.ts";

interface FeishuHistoryRequest {
  chatId: string;
  threadId?: string;
  beforeTs: string;
  isDirect: boolean;
  limit?: number;
}

export interface FeishuHistory {
  priorTurns: ConversationTurn[];
  overheard: OverheardMessage[];
  conversationHeader?: string;
}

export interface FeishuHistoryReader {
  read(request: FeishuHistoryRequest): Promise<FeishuHistory>;
}

function toCachedMessage(
  item: {
    message_id?: string;
    root_id?: string;
    thread_id?: string;
    msg_type?: string;
    create_time?: string;
    deleted?: boolean;
    sender?: { id: string; sender_type: string; sender_name?: string };
    body?: { content: string };
  },
  chatId: string,
  botOpenId: string | undefined,
): CachedMessage | undefined {
  const ts = item.message_id;
  if (!ts) return undefined;
  const self = !!botOpenId && item.sender?.id === botOpenId;
  const sub = item.root_id ?? item.thread_id;
  return {
    container: chatId,
    ts,
    ...(sub ? { sub } : {}),
    ...(item.sender?.id ? { authorId: item.sender.id } : {}),
    ...(item.sender?.sender_name ? { authorName: item.sender.sender_name } : {}),
    text: feishuMessageText(item.msg_type, item.body?.content),
    ...(self ? { self: true } : {}),
    ...(item.sender?.sender_type === "app" ? { bot: true } : {}),
    ...(item.deleted ? { deleted: true } : {}),
    createdAt: Number(item.create_time ?? Date.now()),
  };
}

export function createFeishuHistoryReader(opts: {
  core: FeishuCore;
  channel: Pick<LarkChannel, "rawClient">;
  botOpenId?: string | (() => string | undefined);
}): FeishuHistoryReader {
  const readCached = async (request: FeishuHistoryRequest): Promise<CachedMessage[]> => {
    const read = opts.core.readSurfaceMessages;
    if (!read) return [];
    const base: ReadMessagesOpts = {
      limit: request.limit ?? 200,
      oldestFirst: true,
      orderBy: "createdAt",
      noFallback: true,
    };
    const lists: CachedMessage[][] = [];
    if (request.isDirect) {
      lists.push(await read(request.chatId, base));
    } else {
      lists.push(await read(request.chatId, { ...base, channelHistory: true }));
      if (request.threadId) lists.push(await read(request.chatId, { ...base, sub: request.threadId }));
    }
    const byTs = new Map<string, CachedMessage>();
    for (const list of lists) for (const message of list) byTs.set(message.ts, message);
    return [...byTs.values()].sort((a, b) => a.createdAt - b.createdAt);
  };

  const readLive = async (request: FeishuHistoryRequest): Promise<CachedMessage[]> => {
    const client = opts.channel.rawClient;
    if (!client) return [];
    const botOpenId = typeof opts.botOpenId === "function" ? opts.botOpenId() : opts.botOpenId;
    const limit = request.limit ?? 200;
    const mapped: CachedMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100 && mapped.length < limit; page++) {
      const response = await client.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: request.chatId,
          sort_type: "ByCreateTimeDesc",
          page_size: Math.min(50, limit - mapped.length),
          with_sender_name: true,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      for (const item of response.data?.items ?? []) {
        const message = toCachedMessage(item, request.chatId, botOpenId);
        if (message) mapped.push(message);
      }
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    const filtered = request.threadId
      ? mapped.filter((message) => message.ts === request.threadId || message.sub === request.threadId)
      : mapped;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  };

  return {
    async read(request) {
      let messages = await readCached(request);
      if (messages.length < 2) {
        try {
          const live = await readLive(request);
          if (live.length > messages.length) messages = live;
        } catch (error) {
          reportFailureAs("feishu: live history", undefined)(error);
        }
      }
      const visible = messages
        .filter((message) => message.ts !== request.beforeTs && (message.text.trim() || message.files?.length))
        .slice(-(request.limit ?? 200));
      return {
        priorTurns: visible.map((message) => ({
          role: message.self ? "assistant" : "user",
          ...(message.authorName ? { name: message.authorName } : {}),
          text: message.text,
        })),
        overheard: visible.map((message) => ({
          ts: message.ts,
          role: message.self ? "self" : "user",
          ...(message.authorName ? { name: message.authorName } : {}),
          text: message.text,
          ...(message.files?.length ? { files: message.files.map((file) => file.name ?? file.fileId) } : {}),
        })),
        conversationHeader: request.isDirect ? "Feishu direct message" : "Feishu group conversation",
      };
    },
  };
}
