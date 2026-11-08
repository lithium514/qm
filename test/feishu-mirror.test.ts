import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { messageToIngest } from "../src/feishu/mirror.ts";

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    senderName: "Alice",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1_723_000_000_000,
    ...overrides,
  };
}

test("messageToIngest maps a threaded channel message", () => {
  assert.deepEqual(messageToIngest(message({ rootId: "om_root" })), {
    container: "oc_1",
    ts: "om_1",
    sub: "om_root",
    authorId: "ou_1",
    authorName: "Alice",
    text: "hello",
    mentionsSelf: false,
    createdAt: 1_723_000_000_000,
    kind: "channel",
  });
});

test("messageToIngest marks bot and self messages", () => {
  const self = messageToIngest(message({ senderId: "ou_bot", raw: { sender: { sender_type: "app" } } }), "ou_bot");
  assert.equal(self.self, true);
  assert.equal(self.bot, true);
  const otherBot = messageToIngest(
    message({ senderId: "ou_other", raw: { sender: { sender_type: "app" } } }),
    "ou_bot",
  );
  assert.equal(otherBot.self, undefined);
  assert.equal(otherBot.bot, true);
});

test("messageToIngest carries mentions, files, and DM kind", () => {
  const event = messageToIngest(
    message({
      chatType: "p2p",
      mentions: [{ key: "@_user_1", openId: "ou_2", name: "Bob" }],
      resources: [{ type: "file", fileKey: "fk_1", fileName: "notes.txt" }],
      mentionedBot: true,
    }),
  );
  assert.equal(event.kind, "dm");
  assert.deepEqual(event.mentions, { "@_user_1": "ou_2" });
  assert.deepEqual(event.files, [{ fileId: "fk_1", name: "notes.txt" }]);
  assert.equal(event.mentionsSelf, true);
});
