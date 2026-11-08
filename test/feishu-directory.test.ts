import { test } from "node:test";
import assert from "node:assert/strict";
import { actorFromMember, audienceFromMembers, listChatMembers, type FeishuClient } from "../src/feishu/directory.ts";

function client(
  pages: Array<{
    items: Array<{ member_id?: string; name?: string; tenant_key?: string }>;
    page_token?: string;
    has_more?: boolean;
  }>,
): FeishuClient {
  let index = 0;
  return {
    im: {
      v1: {
        chatMembers: {
          async get() {
            const data = pages[index++] ?? { items: [], has_more: false };
            return { code: 0, data };
          },
        },
      },
    },
  };
}

test("listChatMembers follows pagination and skips unnamed ids", async () => {
  const members = await listChatMembers(
    client([
      {
        items: [{ member_id: "ou_1", name: "Alice" }, { name: "no id" }],
        page_token: "p2",
        has_more: true,
      },
      { items: [{ member_id: "ou_2", tenant_key: "t_1" }], has_more: false },
    ]),
    "oc_1",
  );
  assert.deepEqual(members, [
    { openId: "ou_1", name: "Alice" },
    { openId: "ou_2", tenantKey: "t_1" },
  ]);
});

test("listChatMembers returns an empty list when the chat has no readable members", async () => {
  assert.deepEqual(await listChatMembers(client([]), "oc_1"), []);
});

test("audienceFromMembers dedupes and keeps the sender", () => {
  const sender = { externalId: "ou_1", displayName: "Alice (sender)" };
  assert.deepEqual(
    audienceFromMembers(
      [
        { openId: "ou_1", name: "Alice" },
        { openId: "ou_2", name: "Bob" },
      ],
      sender,
      "ou_1",
    ),
    [
      { externalId: "ou_1", displayName: "Alice" },
      { externalId: "ou_2", displayName: "Bob" },
    ],
  );
  assert.deepEqual(audienceFromMembers([{ openId: "ou_2", name: "Bob" }], sender, "ou_1"), [
    { externalId: "ou_2", displayName: "Bob" },
    { externalId: "ou_1", displayName: "Alice (sender)" },
  ]);
});

test("actorFromMember keeps the open id and optional name", () => {
  assert.deepEqual(actorFromMember({ openId: "ou_1" }), { externalId: "ou_1" });
  assert.deepEqual(actorFromMember({ openId: "ou_1", name: "Alice" }), {
    externalId: "ou_1",
    displayName: "Alice",
  });
});
