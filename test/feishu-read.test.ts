import assert from "node:assert/strict";
import { test } from "node:test";
import { feishuMessageText, readFeishuConversations, type FeishuUserReader } from "../src/feishu/read.ts";

function reader(overrides: Partial<FeishuUserReader> = {}): FeishuUserReader {
  return {
    async viewerOpenId() {
      return "ou_owner";
    },
    async listChats() {
      return [
        { chatId: "oc_dm", isDirect: true },
        { chatId: "oc_group", name: "Budget", isDirect: false },
        { chatId: "oc_empty", name: "Quiet", isDirect: false },
      ];
    },
    async listMembers(chatId) {
      return chatId === "oc_dm" ? [{ id: "ou_ada", name: "Ada" }] : [{ id: "ou_ada", name: "Ada" }, { id: "ou_bot" }];
    },
    async listMessages(chatId) {
      if (chatId === "oc_empty") return [];
      if (chatId === "oc_dm")
        return [{ messageId: "om_1", chatId, senderId: "ou_ada", senderType: "user", at: 10, text: "hello" }];
      return [
        { messageId: "om_2", chatId, senderId: "ou_ada", at: 20, text: "question", threadId: "om_root" },
        { messageId: "om_3", chatId, senderId: "ou_bot", senderType: "app", at: 21, text: "bot" },
      ];
    },
    ...overrides,
  };
}

test("feishu reads text and post bodies", () => {
  assert.equal(feishuMessageText("text", JSON.stringify({ text: "hello" })), "hello");
  assert.equal(
    feishuMessageText(
      "post",
      JSON.stringify({
        title: "Plan",
        content: [
          [
            { tag: "text", text: "line one " },
            { tag: "a", text: "link" },
          ],
          [{ tag: "text", text: "line two" }],
        ],
      }),
    ),
    "Plan\nline one link\nline two",
  );
  assert.equal(feishuMessageText("image", JSON.stringify({ image_key: "img" })), "[image]");
  assert.equal(feishuMessageText("text", "not json"), "");
});

test("feishu conversations carry the viewer, sender names, and thread roots", async () => {
  const result = await readFeishuConversations(reader(), { since: 0, until: 100 });
  assert.equal(result.viewerOpenId, "ou_owner");
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.chatId),
    ["oc_dm", "oc_group"],
  );
  assert.equal(result.conversations[0]?.chatLabel, "oc_dm");
  assert.equal(result.conversations[0]?.messages[0]?.senderName, "Ada");
  assert.equal(result.conversations[1]?.chatLabel, "Budget");
  assert.equal(result.conversations[1]?.messages.length, 1, "bot senders are skipped");
  assert.equal(result.conversations[1]?.messages[0]?.threadId, "om_root");
});

test("feishu reads keep going when one chat's member or message read fails", async () => {
  const result = await readFeishuConversations(
    reader({
      async listMembers(chatId) {
        if (chatId === "oc_dm") throw new Error("members down");
        return [];
      },
      async listMessages(chatId, _since, _until) {
        if (chatId === "oc_empty") return [];
        if (chatId === "oc_group") throw new Error("messages down");
        return [{ messageId: "om_1", chatId, senderId: "ou_ada", at: 10, text: "hello" }];
      },
    }),
    { since: 0, until: 100 },
  );
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.chatId),
    ["oc_dm"],
  );
  assert.equal(result.conversations[0]?.messages[0]?.senderName, undefined);
});

test("feishu reads honor the chat limit", async () => {
  const result = await readFeishuConversations(reader(), { since: 0, until: 100, limit: 1 });
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.chatId),
    ["oc_dm"],
  );
});
