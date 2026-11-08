import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { DirectoryMember } from "../src/directory/directory-store.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import type { TurnRequest } from "../src/types.ts";
import type { FeishuCore } from "../src/feishu/core.ts";
import type { FeishuPluginConfig } from "../src/feishu/config.ts";
import type { FeishuHistory } from "../src/feishu/history.ts";
import type { ConversationEvent } from "../src/loops/sources/adapter.ts";
import { createFeishuMessageHandler, mimeTypeForName } from "../src/feishu/handler.ts";

const config: FeishuPluginConfig = { appId: "cli_1", appSecret: "secret" };

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
    mentionedBot: true,
    createTime: 1_723_000_000_000,
    ...overrides,
  };
}

function harness(
  options: {
    session?: boolean;
    members?: Array<{ openId: string; name?: string }>;
    history?: FeishuHistory;
    principalFor?: (externalId: string) => string;
  } = {},
) {
  const turns: TurnRequest[] = [];
  const sends: unknown[] = [];
  const downloads: Array<{ fileKey: string; type: string }> = [];
  const upserted: DirectoryMember[] = [];
  const ingested: IngestEvent[] = [];
  const inbox: ConversationEvent[] = [];
  const core: FeishuCore = {
    async turn(request) {
      turns.push(request);
      return { status: "queued", runId: "run_1" };
    },
    async hasSession() {
      return options.session ?? false;
    },
    async getApproval() {
      return null;
    },
    async upsertMember(member) {
      upserted.push(member);
    },
    async ingestSurfaceEvents(events) {
      ingested.push(...events);
    },
    async inboxEvent(event) {
      inbox.push(event);
    },
    ...(options.principalFor ? { resolvePrincipal: options.principalFor } : {}),
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "blob_1", sizeBytes: 4 };
    },
    async readBlob() {
      return Buffer.from("data");
    },
  };
  const channel = {
    botIdentity: { openId: "ou_bot" },
    ...(options.members
      ? {
          rawClient: {
            im: {
              v1: {
                chatMembers: {
                  async get() {
                    return {
                      code: 0,
                      data: {
                        items: options.members!.map((member) => ({
                          member_id: member.openId,
                          ...(member.name ? { name: member.name } : {}),
                        })),
                        has_more: false,
                      },
                    };
                  },
                },
              },
            },
          },
        }
      : {}),
    async downloadResource(fileKey: string, type: "image" | "file") {
      downloads.push({ fileKey, type });
      return Buffer.from("data");
    },
    async send(to: string, input: unknown, options?: unknown) {
      sends.push({ to, input, options });
      return { messageId: "om_sent" };
    },
  };
  const handler = createFeishuMessageHandler({
    config,
    core,
    channel,
    ...(options.history ? { readHistory: async () => options.history! } : {}),
  });
  return { handler, turns, sends, downloads, upserted, ingested, inbox };
}

test("feishu group mention becomes a threaded channel turn", async () => {
  const { handler, turns } = harness();
  await handler(message({ rootId: "om_root" }));
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.surface, "feishu");
  assert.equal(turn.actor.externalId, "ou_1");
  assert.equal(turn.actor.displayName, "Alice");
  assert.equal(turn.conversation.kind, "channel");
  assert.equal(turn.conversation.threadRef, "fs:oc_1:om_root");
  assert.equal(turn.conversation.channelRef, "fs:oc_1");
  assert.equal(turn.deliveryTarget, "oc_1:om_root");
  assert.equal(turn.addressed, true);
  assert.equal(turn.async, true);
  assert.equal(turn.redeliveryKey, "feishu:cli_1:om_1");
  assert.equal(turn.origin?.kind, "human");
});

test("feishu DM uses the chat as its session and marks privacy", async () => {
  const { handler, turns } = harness();
  await handler(message({ chatType: "p2p", mentionedBot: false }));
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.conversation.kind, "dm");
  assert.equal(turn.conversation.threadRef, "fs:oc_1");
  assert.equal(turn.conversation.isPrivate, true);
  assert.equal(turn.deliveryTarget, "oc_1");
  assert.equal(turn.addressed, true);
  assert.equal(turn.conversation.channelRef, "fs:oc_1");
});

test("feishu ignores unaddressed group chatter and bot senders", async () => {
  const { handler, turns } = harness();
  await handler(message({ mentionedBot: false }));
  await handler(message({ senderId: "ou_bot" }));
  await handler(message({ raw: { sender: { sender_type: "app" } } }));
  assert.equal(turns.length, 0);
});

test("feishu group turns carry the chat member audience", async () => {
  const { handler, turns } = harness({
    members: [
      { openId: "ou_1", name: "Alice" },
      { openId: "ou_2", name: "Bob" },
    ],
  });
  await handler(message());
  assert.deepEqual(turns[0]!.conversation.audience?.map((actor) => actor.externalId).sort(), ["ou_1", "ou_2"]);
  assert.equal(turns[0]!.conversation.audience?.find((actor) => actor.externalId === "ou_1")?.displayName, "Alice");
});

test("feishu follows a bot thread without a mention", async () => {
  const { handler, turns } = harness({ session: true });
  await handler(message({ mentionedBot: false, rootId: "om_root", content: "and then?" }));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.addressed, true);
  assert.equal(turns[0]!.conversation.threadRef, "fs:oc_1:om_root");
  assert.equal(turns[0]!.deliveryTarget, "oc_1:om_root");
});

test("feishu stages inbound files onto the turn", async () => {
  const { handler, turns, downloads } = harness();
  await handler(
    message({
      resources: [
        { type: "file", fileKey: "fk_1", fileName: "notes.txt" },
        { type: "image", fileKey: "fk_2" },
      ],
    }),
  );
  assert.deepEqual(downloads, [
    { fileKey: "fk_1", type: "file" },
    { fileKey: "fk_2", type: "image" },
  ]);
  assert.deepEqual(turns[0]!.attachments, [
    {
      name: "notes.txt",
      mimetype: "text/plain",
      sizeBytes: 4,
      blobId: "blob_1",
      sourceId: "fk_1",
      author: "Alice",
    },
    {
      name: "image-fk_2.png",
      mimetype: "image/png",
      sizeBytes: 4,
      blobId: "blob_1",
      sourceId: "fk_2",
      author: "Alice",
    },
  ]);
});

test("mimeTypeForName covers common files and defaults to octet-stream", () => {
  assert.equal(mimeTypeForName("a.PNG"), "image/png");
  assert.equal(mimeTypeForName("a.pdf"), "application/pdf");
  assert.equal(mimeTypeForName("a.bin"), "application/octet-stream");
  assert.equal(mimeTypeForName("README"), "application/octet-stream");
});

test("feishu upserts the inbound sender into the directory", async () => {
  const { handler, upserted } = harness();
  await handler(message({ senderId: "ou_2", senderName: "Bob" }));
  assert.deepEqual(upserted, [{ principalId: "ou_2", displayName: "Bob", type: "internal" }]);
});

test("feishu mirrors unaddressed group messages without starting a turn", async () => {
  const { handler, turns, ingested } = harness();
  await handler(message({ mentionedBot: false }));
  assert.equal(turns.length, 0);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0]!.container, "oc_1");
  assert.equal(ingested[0]!.text, "hello");
});

test("feishu injects prior conversation context into the turn", async () => {
  const history: FeishuHistory = {
    priorTurns: [{ role: "user", text: "earlier" }],
    overheard: [{ ts: "om_0", role: "user", text: "earlier" }],
    conversationHeader: "Feishu group conversation",
  };
  const { handler, turns } = harness({ history });
  await handler(message());
  assert.deepEqual(turns[0]!.priorTurns, history.priorTurns);
  assert.deepEqual(turns[0]!.overheard, history.overheard);
  assert.equal(turns[0]!.conversationHeader, "Feishu group conversation");
});

test("feishu messages feed the inbox realtime as Feishu conversation events", async () => {
  const { handler, inbox } = harness();
  await handler(message({ rootId: "om_root" }));
  assert.deepEqual(inbox[0], {
    source: "feishu",
    conversationRef: "oc_1:om_root",
    at: 1_723_000_000_000,
    text: "hello",
    senderId: "ou_1",
  });
});

test("feishu DMs use the chat id and unaddressed chatter still refreshes its inbox item", async () => {
  const dm = harness();
  await dm.handler(message({ chatType: "p2p", mentionedBot: false }));
  assert.equal(dm.inbox[0]?.conversationRef, "oc_1");

  const quiet = harness();
  await quiet.handler(message({ mentionedBot: false }));
  assert.equal(quiet.turns.length, 0);
  assert.equal(quiet.inbox.length, 1);
});

test("feishu bot senders do not feed the inbox", async () => {
  const { handler, inbox } = harness();
  await handler(message({ senderId: "ou_bot" }));
  assert.equal(inbox.length, 0);
});

test("feishu inbox events carry the linked principal id, not the open id", async () => {
  const { handler, inbox } = harness({ principalFor: (id) => (id === "ou_1" ? "alice@example.com" : id) });
  await handler(message());
  assert.equal(inbox[0]?.senderId, "alice@example.com");
});
