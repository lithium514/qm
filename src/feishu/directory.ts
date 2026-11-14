import type { Readable } from "node:stream";
import type { ActorAssertion } from "../types.ts";

export interface FeishuChatMember {
  openId: string;
  name?: string;
  tenantKey?: string;
}

export interface FeishuChat {
  chatId: string;
  name?: string;
  chatMode?: string;
  chatType?: string;
  external?: boolean;
  tenantKey?: string;
}

export interface FeishuClient {
  im: {
    v1: {
      chat?: {
        list(payload: {
          params: { page_size: number; page_token?: string; sort_type: "ByCreateTimeAsc"; types?: string };
        }): Promise<{
          data?: {
            items?: Array<{
              chat_id?: string;
              name?: string;
              chat_mode?: string;
              chat_type?: string;
              external?: boolean;
              tenant_key?: string;
            }>;
            page_token?: string;
            has_more?: boolean;
          };
        }>;
      };
      chatMembers: {
        get(payload: {
          path: { chat_id: string };
          params: { member_id_type: "open_id"; page_size: number; page_token?: string };
        }): Promise<{
          data?: {
            items?: Array<{ member_id?: string; name?: string; tenant_key?: string }>;
            page_token?: string;
            has_more?: boolean;
          };
        }>;
      };
      messageResource?: {
        get(payload: {
          path: { message_id: string; file_key: string };
          params: { type: string };
        }): Promise<{ getReadableStream(): Readable }>;
      };
    };
  };
}

export async function listChatMembers(
  client: FeishuClient,
  chatId: string,
  pageSize = 100,
): Promise<FeishuChatMember[]> {
  const out: FeishuChatMember[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const response = await client.im.v1.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        member_id_type: "open_id",
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    for (const item of response.data?.items ?? []) {
      if (!item.member_id) continue;
      out.push({
        openId: item.member_id,
        ...(item.name ? { name: item.name } : {}),
        ...(item.tenant_key ? { tenantKey: item.tenant_key } : {}),
      });
    }
    if (!response.data?.has_more || !response.data.page_token) return out;
    pageToken = response.data.page_token;
  }
}

export function actorFromMember(member: FeishuChatMember): ActorAssertion {
  return {
    externalId: member.openId,
    ...(member.name ? { displayName: member.name } : {}),
  };
}

export function audienceFromMembers(
  members: readonly FeishuChatMember[],
  sender: ActorAssertion,
  senderOpenId: string,
): ActorAssertion[] {
  const byId = new Map<string, ActorAssertion>();
  for (const member of members) {
    const actor = actorFromMember(member);
    byId.set(actor.externalId, actor);
  }
  if (!byId.has(senderOpenId)) byId.set(senderOpenId, sender);
  return [...byId.values()];
}

export async function listChats(client: FeishuClient, pageSize = 100): Promise<FeishuChat[]> {
  const chatApi = client.im.v1.chat;
  if (!chatApi) return [];
  const out: FeishuChat[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const response = await chatApi.list({
      params: {
        page_size: pageSize,
        sort_type: "ByCreateTimeAsc",
        types: "group",
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    for (const item of response.data?.items ?? []) {
      if (!item.chat_id) continue;
      out.push({
        chatId: item.chat_id,
        ...(item.name ? { name: item.name } : {}),
        ...(item.chat_mode ? { chatMode: item.chat_mode } : {}),
        ...(item.chat_type ? { chatType: item.chat_type } : {}),
        ...(item.external ? { external: true } : {}),
        ...(item.tenant_key ? { tenantKey: item.tenant_key } : {}),
      });
    }
    if (!response.data?.has_more || !response.data.page_token) return out;
    pageToken = response.data.page_token;
  }
}
