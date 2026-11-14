import { test } from "node:test";
import assert from "node:assert/strict";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { CachedMessage } from "../src/surface-cache/types.ts";
import type { FeishuCore } from "../src/feishu/core.ts";
import { createFeishuHistoryReader } from "../src/feishu/history.ts";

function cached(overrides: Partial<CachedMessage> & Pick<CachedMessage, "ts">): CachedMessage {
  return {
    container: "oc_1",
    text: "",
    createdAt: 0,
    ...overrides,
  };
}

function core(messages: CachedMessage[]): FeishuCore {
  return {
    async readSurfaceMessages() {
      return messages;
    },
  } as unknown as FeishuCore;
}

const noLive = { rawClient: undefined } as unknown as Pick<LarkChannel, "rawClient">;

test("feishu history reader returns prior turns and overheard messages", async () => {
  const reader = createFeishuHistoryReader({
    core: core([
      cached({ ts: "om_1", authorName: "Alice", text: "hello", createdAt: 1000 }),
      cached({ ts: "om_2", authorName: "qm", text: "hi", self: true, bot: true, createdAt: 2000 }),
      cached({ ts: "om_current", authorName: "Alice", text: "current", createdAt: 3000 }),
    ]),
    channel: noLive,
    botOpenId: "ou_bot",
  });
  const history = await reader.read({ chatId: "oc_1", threadId: "om_root", beforeTs: "om_current", isDirect: false });
  assert.deepEqual(history.priorTurns, [
    { role: "user", name: "Alice", text: "hello" },
    { role: "assistant", name: "qm", text: "hi" },
  ]);
  assert.deepEqual(history.overheard, [
    { ts: "om_1", role: "user", name: "Alice", text: "hello" },
    { ts: "om_2", role: "self", name: "qm", text: "hi" },
  ]);
  assert.equal(history.conversationHeader, "Feishu group conversation");
});

test("feishu history reader falls back to live history and parses text and post", async () => {
  const live = {
    rawClient: {
      im: {
        v1: {
          message: {
            async list() {
              return {
                data: {
                  items: [
                    {
                      message_id: "om_1",
                      root_id: "om_root",
                      msg_type: "text",
                      create_time: "1000",
                      sender: { id: "ou_alice", sender_type: "user", sender_name: "Alice" },
                      body: { content: JSON.stringify({ text: "hello" }) },
                    },
                    {
                      message_id: "om_2",
                      root_id: "om_root",
                      msg_type: "post",
                      create_time: "2000",
                      sender: { id: "ou_bot", sender_type: "app", sender_name: "qm" },
                      body: {
                        content: JSON.stringify({
                          zh_cn: {
                            title: "Title",
                            content: [
                              [
                                { tag: "text", text: "hi " },
                                { tag: "at", user_name: "Alice" },
                              ],
                            ],
                          },
                        }),
                      },
                    },
                  ],
                },
              };
            },
          },
        },
      },
    },
  } as unknown as Pick<LarkChannel, "rawClient">;
  const reader = createFeishuHistoryReader({ core: core([]), channel: live, botOpenId: "ou_bot" });
  const history = await reader.read({ chatId: "oc_1", threadId: "om_root", beforeTs: "om_3", isDirect: false });
  assert.deepEqual(history.priorTurns, [
    { role: "user", name: "Alice", text: "hello" },
    { role: "assistant", name: "qm", text: "Title\nhi @Alice" },
  ]);
  assert.deepEqual(
    history.overheard.map((message) => [message.ts, message.role, message.text]),
    [
      ["om_1", "user", "hello"],
      ["om_2", "self", "Title\nhi @Alice"],
    ],
  );
});
