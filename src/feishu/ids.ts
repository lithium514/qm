export const FEISHU_SURFACE = "feishu";
export const FEISHU_REF_PREFIX = "fs";

export interface FeishuRef {
  chatId: string;
  threadId?: string;
}

export function feishuSendOptions(target: FeishuRef): { replyTo: string; replyInThread: boolean } | undefined {
  return target.threadId ? { replyTo: target.threadId, replyInThread: true } : undefined;
}

function validPart(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes(":");
}

export function feishuContainerRef(chatId: string): string {
  if (!validPart(chatId)) throw new Error(`invalid Feishu chat id: ${JSON.stringify(chatId)}`);
  return `${FEISHU_REF_PREFIX}:${chatId}`;
}

export function feishuThreadRef(chatId: string, threadId?: string): string {
  if (threadId !== undefined && !validPart(threadId))
    throw new Error(`invalid Feishu thread id: ${JSON.stringify(threadId)}`);
  return threadId === undefined ? feishuContainerRef(chatId) : `${feishuContainerRef(chatId)}:${threadId}`;
}

export function parseFeishuRef(ref: string | undefined): FeishuRef | undefined {
  if (!ref) return undefined;
  const parts = ref.split(":");
  if (parts[0] !== FEISHU_REF_PREFIX) return undefined;
  if (parts.length === 2 && validPart(parts[1])) return { chatId: parts[1] };
  if (parts.length === 3 && validPart(parts[1]) && validPart(parts[2])) return { chatId: parts[1], threadId: parts[2] };
  return undefined;
}

export function isFeishuRef(ref: string | undefined): boolean {
  return parseFeishuRef(ref) !== undefined;
}

export function feishuConversationKind(chatType: string | undefined): "dm" | "channel" {
  return chatType === "p2p" ? "dm" : "channel";
}

export function feishuDeliveryTarget(chatId: string, threadId?: string): string {
  if (!validPart(chatId)) throw new Error(`invalid Feishu chat id: ${JSON.stringify(chatId)}`);
  if (threadId !== undefined && !validPart(threadId))
    throw new Error(`invalid Feishu thread id: ${JSON.stringify(threadId)}`);
  return threadId === undefined ? chatId : `${chatId}:${threadId}`;
}

export function parseFeishuDeliveryTarget(target: string | undefined): FeishuRef | undefined {
  if (!target) return undefined;
  const parts = target.split(":");
  if (parts.length === 1 && validPart(parts[0])) return { chatId: parts[0] };
  if (parts.length === 2 && validPart(parts[0]) && validPart(parts[1])) return { chatId: parts[0], threadId: parts[1] };
  return undefined;
}
