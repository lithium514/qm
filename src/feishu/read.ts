import * as lark from "@larksuiteoapi/node-sdk";

export interface FeishuReaderChat {
  chatId: string;
  name?: string;
  isDirect: boolean;
}

export interface FeishuReaderMember {
  id: string;
  name?: string;
}

export interface FeishuReaderMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  senderType?: string;
  at: number;
  text: string;
  threadId?: string;
}

export interface FeishuUserReader {
  viewerOpenId(): Promise<string | undefined>;
  listChats(): Promise<FeishuReaderChat[]>;
  listMembers(chatId: string): Promise<FeishuReaderMember[]>;
  listMessages(chatId: string, since: number, until: number): Promise<FeishuReaderMessage[]>;
}

export interface FeishuConversation {
  chatId: string;
  chatLabel: string;
  isDirectMessage: boolean;
  messages: Array<FeishuReaderMessage & { senderName?: string }>;
}

export interface FeishuConversationsResult {
  viewerOpenId?: string;
  conversations: FeishuConversation[];
}

const MAX_PAGES = 5;

function textOfPost(value: unknown): string {
  const root = value as { title?: unknown; content?: unknown };
  const lines: string[] = [];
  if (typeof root?.title === "string" && root.title.trim()) lines.push(root.title.trim());
  const rows = Array.isArray(root?.content) ? root.content : [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const parts: string[] = [];
    for (const item of row) {
      const tag = item as { tag?: unknown; text?: unknown };
      if (typeof tag?.text === "string") parts.push(tag.text);
    }
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export function feishuMessageText(msgType: string, content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (msgType === "text") {
      const text = (parsed as { text?: unknown })?.text;
      return typeof text === "string" ? text : "";
    }
    if (msgType === "post") return textOfPost(parsed);
  } catch {
    return "";
  }
  return `[${msgType}]`;
}

function chatIsDirect(chat: { chat_mode?: string; chat_type?: string }): boolean {
  return chat.chat_mode === "p2p" || chat.chat_type === "p2p";
}

export function feishuUserReaderFactory(appId: string, appSecret: string): (token: string) => FeishuUserReader {
  return (token) => createFeishuUserReader(appId, appSecret, token);
}

export function createFeishuUserReader(appId: string, appSecret: string, token: string): FeishuUserReader {
  const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild });
  const options = lark.withUserAccessToken(token);
  return {
    async viewerOpenId() {
      const res = await client.authen.v1.userInfo.get({}, options);
      return res.data?.open_id;
    },
    async listChats() {
      const res = await client.im.v1.chat.list({ params: { page_size: 100, user_id_type: "open_id" } }, options);
      return (res.data?.items ?? []).flatMap((chat) => {
        const chatId = chat.chat_id;
        if (!chatId) return [];
        return [
          {
            chatId,
            ...(chat.name ? { name: chat.name } : {}),
            isDirect: chatIsDirect(chat),
          },
        ];
      });
    },
    async listMembers(chatId) {
      const res = await client.im.v1.chatMembers.get(
        {
          path: { chat_id: chatId },
          params: { member_id_type: "open_id", page_size: 100 },
        },
        options,
      );
      return (res.data?.items ?? []).flatMap((member) => {
        const id = member.member_id;
        if (!id) return [];
        return [{ id, ...(member.name ? { name: member.name } : {}) }];
      });
    },
    async listMessages(chatId, since, until) {
      const out: FeishuReaderMessage[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.im.v1.message.list(
          {
            params: {
              container_id_type: "chat",
              container_id: chatId,
              start_time: String(Math.floor(since / 1000)),
              end_time: String(Math.floor(until / 1000)),
              sort_type: "ByCreateTimeAsc",
              page_size: 50,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
          options,
        );
        for (const message of res.data?.items ?? []) {
          if (!message.message_id) continue;
          const senderId = message.sender?.id;
          if (!senderId) continue;
          const threadId = message.root_id ?? (message as { thread_id?: string }).thread_id;
          out.push({
            messageId: message.message_id,
            chatId,
            senderId,
            ...(message.sender?.sender_type ? { senderType: message.sender.sender_type } : {}),
            at: Number(message.create_time ?? 0),
            text: feishuMessageText(message.msg_type ?? "", message.body?.content),
            ...(threadId ? { threadId } : {}),
          });
        }
        if (!res.data?.has_more || !res.data.page_token) break;
        pageToken = res.data.page_token;
      }
      return out;
    },
  };
}

export async function readFeishuConversations(
  reader: FeishuUserReader,
  opts: { since: number; until: number; limit?: number },
): Promise<FeishuConversationsResult> {
  const [viewerOpenId, chats] = await Promise.all([reader.viewerOpenId().catch(() => undefined), reader.listChats()]);
  const conversations: FeishuConversation[] = [];
  for (const chat of chats.slice(0, opts.limit ?? 50)) {
    const [members, messages] = await Promise.all([
      reader.listMembers(chat.chatId).catch(() => []),
      reader.listMessages(chat.chatId, opts.since, opts.until).catch(() => []),
    ]);
    const names = new Map(members.map((member) => [member.id, member.name] as const));
    const human = messages.filter((message) => message.senderType !== "app");
    if (!human.length) continue;
    conversations.push({
      chatId: chat.chatId,
      chatLabel: chat.name ?? chat.chatId,
      isDirectMessage: chat.isDirect,
      messages: human.map((message) => ({
        ...message,
        ...(names.get(message.senderId) ? { senderName: names.get(message.senderId) } : {}),
      })),
    });
  }
  return { ...(viewerOpenId ? { viewerOpenId } : {}), conversations };
}
