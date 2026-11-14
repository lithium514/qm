import { isObj } from "../util/objects.ts";

function rec(value: unknown): Record<string, unknown> | undefined {
  return isObj(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coerced(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface FeishuEventEnvelope {
  eventId?: string;
  eventType?: string;
  tenantKey?: string;
  appId?: string;
  event: Record<string, unknown>;
}

export function parseEventEnvelope(body: unknown): FeishuEventEnvelope | undefined {
  const root = rec(body);
  if (!root) return undefined;
  const header = rec(root.header);
  const event = rec(root.event) ?? root;
  return {
    ...(str(header?.event_id) ? { eventId: str(header?.event_id) } : {}),
    ...(str(header?.event_type) ? { eventType: str(header?.event_type) } : {}),
    ...(str(header?.tenant_key) ? { tenantKey: str(header?.tenant_key) } : {}),
    ...(str(header?.app_id) ? { appId: str(header?.app_id) } : {}),
    event,
  };
}

export interface FeishuQmAction {
  action: string;
  id?: string;
  value?: string;
}

export function parseQmAction(value: unknown): FeishuQmAction | undefined {
  const v = rec(value);
  const action = str(v?.qm);
  if (!action) return undefined;
  const id = str(v?.id);
  const payload = str(v?.value);
  return {
    action,
    ...(id ? { id } : {}),
    ...(payload ? { value: payload } : {}),
  };
}

export function qmActionValue(action: string, id?: string, value?: string): Record<string, string> {
  return {
    qm: action,
    ...(id ? { id } : {}),
    ...(value ? { value } : {}),
  };
}

export interface FeishuCardAction {
  eventId?: string;
  tenantKey?: string;
  operatorOpenId: string;
  operatorUserId?: string;
  messageId: string;
  chatId: string;
  actionTag?: string;
  actionName?: string;
  value?: unknown;
}

export function parseCardAction(body: unknown): FeishuCardAction | undefined {
  const root = rec(body);
  const envelope = parseEventEnvelope(body);
  if (!root || !envelope) return undefined;
  const event = envelope.event;
  const operator = rec(event.operator);
  const context = rec(event.context);
  const action = rec(event.action);
  const operatorOpenId = str(operator?.open_id) ?? str(event.open_id) ?? "";
  const messageId = str(context?.open_message_id) ?? str(event.open_message_id) ?? "";
  if (!operatorOpenId || !messageId) return undefined;
  return {
    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
    ...(envelope.tenantKey ? { tenantKey: envelope.tenantKey } : {}),
    operatorOpenId,
    ...(str(operator?.user_id) ? { operatorUserId: str(operator?.user_id) } : {}),
    messageId,
    chatId: str(context?.open_chat_id) ?? str(event.open_chat_id) ?? "",
    ...(str(action?.tag) ? { actionTag: str(action?.tag) } : {}),
    ...(str(action?.name) ? { actionName: str(action?.name) } : {}),
    ...(action?.value !== undefined ? { value: action.value } : {}),
  };
}

export interface FeishuReaction {
  eventId?: string;
  tenantKey?: string;
  messageId: string;
  emojiType: string;
  operatorOpenId: string;
  action: "added" | "removed";
  actionTime?: number;
}

export function parseReactionEvent(body: unknown, action: "added" | "removed"): FeishuReaction | undefined {
  const envelope = parseEventEnvelope(body);
  if (!envelope) return undefined;
  const event = envelope.event;
  const messageId = str(event.message_id) ?? "";
  const emojiType = str(rec(event.reaction_type)?.emoji_type) ?? "";
  const operatorOpenId = str(rec(event.user_id)?.open_id) ?? "";
  if (!messageId || !emojiType || !operatorOpenId) return undefined;
  return {
    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
    ...(envelope.tenantKey ? { tenantKey: envelope.tenantKey } : {}),
    messageId,
    emojiType,
    operatorOpenId,
    action,
    ...(num(event.action_time) !== undefined ? { actionTime: num(event.action_time) } : {}),
  };
}

export interface FeishuRecall {
  eventId?: string;
  tenantKey?: string;
  messageId: string;
  chatId?: string;
  recallTime?: number;
  operatorOpenId?: string;
}

export function parseMessageRecall(body: unknown): FeishuRecall | undefined {
  const envelope = parseEventEnvelope(body);
  if (!envelope) return undefined;
  const event = envelope.event;
  const messageId = str(event.message_id) ?? "";
  if (!messageId) return undefined;
  const operator = rec(event.operator_id);
  return {
    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
    ...(envelope.tenantKey ? { tenantKey: envelope.tenantKey } : {}),
    messageId,
    ...(coerced(event.chat_id) ? { chatId: coerced(event.chat_id) } : {}),
    ...(num(event.recall_time) !== undefined ? { recallTime: num(event.recall_time) } : {}),
    ...(str(operator?.open_id) ? { operatorOpenId: str(operator?.open_id) } : {}),
  };
}

function postText(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const post = value as { title?: unknown; content?: unknown };
  const lines = Array.isArray(post.content) ? post.content : [];
  const rendered = lines.map((line) => {
    if (!Array.isArray(line)) return "";
    return line
      .map((node) => {
        if (typeof node !== "object" || node === null) return "";
        const n = node as Record<string, unknown>;
        if (typeof n.text === "string") return n.text;
        if (typeof n.user_name === "string") return `@${n.user_name}`;
        if (typeof n.user_id === "string") return `@${n.user_id}`;
        if (typeof n.emoji_type === "string") return `:${n.emoji_type}:`;
        if (n.tag === "img") return "[image]";
        if (n.tag === "media") return "[media]";
        return "";
      })
      .join("");
  });
  return [typeof post.title === "string" ? post.title : "", ...rendered].filter((line) => line.trim()).join("\n");
}

export function feishuMessageText(messageType: string | undefined, content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed: unknown = JSON.parse(content);
    if (messageType === "text") {
      const text = (parsed as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    if (messageType === "post") {
      const localized = parsed as Record<string, unknown>;
      const post =
        localized.zh_cn ??
        localized.en_us ??
        (Array.isArray(localized.content) ? localized : Object.values(localized)[0]);
      return postText(post);
    }
  } catch {
    return "";
  }
  return messageType ? `[${messageType}]` : "";
}
