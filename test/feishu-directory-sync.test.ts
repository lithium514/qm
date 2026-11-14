import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelMembership,
  DirectoryChannel,
  DirectoryMember,
  DirectoryStore,
} from "../src/directory/directory-store.ts";
import type { FeishuClient } from "../src/feishu/directory.ts";
import { listChats } from "../src/feishu/directory.ts";
import { createFeishuDirectorySync } from "../src/feishu/directory-sync.ts";

function client(
  chats: Array<Record<string, unknown>>,
  members: Record<string, Array<{ member_id?: string; name?: string; tenant_key?: string }>>,
  pages?: Array<{ items: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean }>,
): FeishuClient {
  return {
    im: {
      v1: {
        chat: {
          async list({ params }: { params: { page_size: number; page_token?: string; sort_type: string } }) {
            if (pages) {
              const page = pages[Number(params.page_token ?? 0)] ?? { items: [], has_more: false };
              return { data: page };
            }
            return { data: { items: chats, has_more: false } };
          },
        },
        chatMembers: {
          async get({ path }: { path: { chat_id: string } }) {
            return { data: { items: members[path.chat_id] ?? [], has_more: false } };
          },
        },
      },
    },
  } as unknown as FeishuClient;
}

function directory(): {
  store: DirectoryStore;
  members: DirectoryMember[];
  channels: DirectoryChannel[];
  memberships: ChannelMembership[];
} {
  const state = {
    members: [] as DirectoryMember[],
    channels: [] as DirectoryChannel[],
    memberships: [] as ChannelMembership[],
    store: undefined as unknown as DirectoryStore,
  };
  state.store = {
    async upsertMembers(members: DirectoryMember[]) {
      state.members = members;
    },
    async upsertChannels(channels: DirectoryChannel[], memberships: ChannelMembership[]) {
      state.channels = channels;
      state.memberships = memberships;
    },
  } as unknown as DirectoryStore;
  return state;
}

test("listChats follows pagination", async () => {
  const chats = await listChats(
    client([], {}, [
      { items: [{ chat_id: "oc_1", name: "one" }], page_token: "1", has_more: true },
      { items: [{ chat_id: "oc_2", name: "two" }], has_more: false },
    ]),
  );
  assert.deepEqual(
    chats.map((chat) => chat.chatId),
    ["oc_1", "oc_2"],
  );
});

test("feishu directory sync upserts members, external guests, channels, and excludes the bot", async () => {
  const state = directory();
  const sync = createFeishuDirectorySync({
    client: client(
      [
        { chat_id: "oc_1", name: "team", chat_mode: "group", chat_type: "public", tenant_key: "t1" },
        { chat_id: "oc_2", name: "partner", chat_mode: "group", chat_type: "public", external: true, tenant_key: "t2" },
        { chat_id: "oc_3", chat_mode: "p2p", chat_type: "private", tenant_key: "t1" },
      ],
      {
        oc_1: [
          { member_id: "ou_alice", name: "Alice", tenant_key: "t1" },
          { member_id: "ou_bob", name: "Bob", tenant_key: "t1" },
          { member_id: "ou_bot", name: "qm", tenant_key: "t1" },
        ],
        oc_2: [
          { member_id: "ou_ext", name: "Partner", tenant_key: "t2" },
          { member_id: "ou_bot", name: "qm", tenant_key: "t1" },
        ],
        oc_3: [
          { member_id: "ou_alice", name: "Alice", tenant_key: "t1" },
          { member_id: "ou_bot", name: "qm", tenant_key: "t1" },
        ],
      },
    ),
    directory: state.store,
    botOpenId: "ou_bot",
  });
  await sync.run();
  assert.deepEqual(
    state.members.map((member) => [member.principalId, member.displayName, member.type]),
    [
      ["ou_alice", "Alice", "internal"],
      ["ou_bob", "Bob", "internal"],
      ["ou_ext", "Partner", "guest"],
    ],
  );
  assert.deepEqual(
    state.channels.map((channel) => [channel.channelId, channel.name, !!channel.isPrivate, !!channel.isExternal]),
    [
      ["oc_1", "team", false, false],
      ["oc_2", "partner", false, true],
      ["oc_3", "oc_3", true, false],
    ],
  );
  assert.deepEqual(
    state.memberships.map((member) => `${member.channelId}:${member.principalId}`),
    ["oc_1:ou_alice", "oc_1:ou_bob", "oc_2:ou_ext", "oc_3:ou_alice"],
  );
});
