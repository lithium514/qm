import { test } from "node:test";
import assert from "node:assert/strict";
import { LarkChannelError } from "@larksuiteoapi/node-sdk";
import type { Delivery } from "../src/types.ts";
import type { FeishuCore } from "../src/feishu/core.ts";
import { createFeishuDeliveryPoller } from "../src/feishu/delivery.ts";

function delivery(overrides: Partial<Delivery> & Pick<Delivery, "id" | "destination">): Delivery {
  return {
    text: "",
    idempotencyKey: `key-${overrides.id}`,
    createdAt: Date.now(),
    deliveredAt: null,
    ...overrides,
  } as Delivery;
}

function fakeCore(rows: Delivery[], sent: Array<{ id: string; providerApiMs?: number }> = []): FeishuCore {
  return {
    async turn() {
      throw new Error("not used");
    },
    async getApproval() {
      return null;
    },
    async pendingDeliveries() {
      return rows;
    },
    async ackDelivery(id, providerApiMs) {
      sent.push({ id, ...(providerApiMs !== undefined ? { providerApiMs } : {}) });
    },
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      throw new Error("not used");
    },
    async readBlob() {
      return Buffer.from("file-bytes");
    },
  };
}

test("feishu poller posts markdown in the delivery thread and acks", async () => {
  const sends: unknown[] = [];
  const acks: Array<{ id: string; providerApiMs?: number }> = [];
  const channel = {
    async send(to: string, input: unknown, options?: unknown) {
      sends.push({ to, input, options });
      return { messageId: "om_sent" };
    },
  };
  const poller = createFeishuDeliveryPoller({
    core: fakeCore([delivery({ id: "d1", destination: { type: "feishu", target: "oc_1:om_2" }, text: "hello" })], acks),
    channel,
  });
  assert.equal(await poller.drain(), 1);
  assert.deepEqual(sends, [
    { to: "oc_1", input: { markdown: "hello" }, options: { replyTo: "om_2", replyInThread: true } },
  ]);
  assert.equal(acks.length, 1);
  assert.ok(acks[0]!.providerApiMs !== undefined);
});

test("feishu poller posts attachments as image or file", async () => {
  const sends: unknown[] = [];
  const poller = createFeishuDeliveryPoller({
    core: fakeCore([
      delivery({
        id: "d1",
        destination: { type: "feishu", target: "oc_1" },
        attachments: [
          { name: "a.png", mimetype: "image/png", sizeBytes: 4, blobId: "b1" },
          { name: "b.txt", mimetype: "text/plain", sizeBytes: 4, blobId: "b2" },
        ],
      }),
    ]),
    channel: {
      async send(to: string, input: unknown, options?: unknown) {
        sends.push({ to, input, options });
        return { messageId: "om_sent" };
      },
    },
  });
  await poller.drain();
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], {
    to: "oc_1",
    input: { image: { source: Buffer.from("file-bytes") } },
    options: undefined,
  });
  assert.deepEqual(sends[1], {
    to: "oc_1",
    input: { file: { source: Buffer.from("file-bytes"), fileName: "b.txt" } },
    options: undefined,
  });
});

test("feishu poller fails an invalid target instead of retrying", async () => {
  const failed: Array<{ id: string; reason: string }> = [];
  const core = fakeCore([delivery({ id: "d1", destination: { type: "feishu", target: "a:b:c" } })]);
  core.failDelivery = async (id, reason) => {
    failed.push({ id, reason });
    return null;
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send() {
        throw new Error("must not send");
      },
    },
  });
  assert.equal(await poller.drain(), 1);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.reason, /invalid Feishu delivery target/);
});

test("feishu poller drops a permanently refused delivery", async () => {
  const failed: Array<{ id: string; reason: string }> = [];
  const core = fakeCore([delivery({ id: "d1", destination: { type: "feishu", target: "oc_1" }, text: "hi" })]);
  core.failDelivery = async (id, reason) => {
    failed.push({ id, reason });
    return null;
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send() {
        throw new LarkChannelError("permission_denied", "no permission");
      },
    },
  });
  await poller.drain();
  assert.deepEqual(failed, [{ id: "d1", reason: "no permission" }]);
});

test("feishu poller renders a command approval as a card", async () => {
  const sends: unknown[] = [];
  const acks: string[] = [];
  const core = fakeCore([
    delivery({
      id: "d1",
      destination: { type: "feishu", target: "oc_1", commandApprovalId: "a_1" },
      text: "Approval needed: rm -rf build",
    }),
  ]);
  core.getApproval = async () => ({
    requestId: "a_1",
    command: "rm -rf build",
    reason: "destructive",
  });
  core.ackDelivery = async (id) => {
    acks.push(id);
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send(to: string, input: unknown, options?: unknown) {
        sends.push({ to, input, options });
        return { messageId: "om_card" };
      },
    },
  });
  await poller.drain();
  assert.equal(sends.length, 1);
  const sent = sends[0] as { to: string; input: { card?: { header?: { title?: { content?: string } } } } };
  assert.equal(sent.to, "oc_1");
  assert.equal(sent.input.card?.header?.title?.content, "Approval needed");
  assert.deepEqual(acks, ["d1"]);
});

test("feishu poller silently acks a stale approval instead of posting an expired card", async () => {
  const sends: unknown[] = [];
  const acks: string[] = [];
  const core = fakeCore([
    delivery({
      id: "d1",
      destination: { type: "feishu", target: "oc_1", commandApprovalId: "a_1" },
    }),
  ]);
  core.getApproval = async () => null;
  core.ackDelivery = async (id) => {
    acks.push(id);
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send(to: string, input: unknown) {
        sends.push({ to, input });
        return { messageId: "om_sent" };
      },
    },
  });
  await poller.drain();
  assert.deepEqual(sends, []);
  assert.deepEqual(acks, ["d1"]);
});

test("feishu poller silently acks a stale credential approval", async () => {
  const sends: unknown[] = [];
  const acks: string[] = [];
  const core = fakeCore([
    delivery({
      id: "d1",
      destination: { type: "feishu", target: "oc_1", keychainAskId: "k_1" },
    }),
  ]);
  core.keychainApprovals = {
    async get() {
      return null;
    },
    async card() {
      return null;
    },
    async decide() {
      throw new Error("not used");
    },
  };
  core.ackDelivery = async (id) => {
    acks.push(id);
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send(to: string, input: unknown) {
        sends.push({ to, input });
        return { messageId: "om_sent" };
      },
    },
  });
  await poller.drain();
  assert.deepEqual(sends, []);
  assert.deepEqual(acks, ["d1"]);
});

test("feishu poller leaves a transient failure unacked for retry", async () => {
  const acks: string[] = [];
  const failed: string[] = [];
  const core = fakeCore([delivery({ id: "d1", destination: { type: "feishu", target: "oc_1" }, text: "hi" })]);
  core.ackDelivery = async (id) => {
    acks.push(id);
  };
  core.failDelivery = async (id) => {
    failed.push(id);
    return null;
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send() {
        throw new LarkChannelError("rate_limited", "slow down");
      },
    },
  });
  await poller.drain();
  assert.deepEqual(acks, []);
  assert.deepEqual(failed, []);
});

test("feishu poller renders a credential approval as a card", async () => {
  const sends: unknown[] = [];
  const acks: string[] = [];
  const core = fakeCore([
    delivery({
      id: "d1",
      destination: { type: "feishu", target: "oc_1", keychainAskId: "k_1" },
      text: "Approval needed: use your GitHub credential",
    }),
  ]);
  core.keychainApprovals = {
    async get() {
      return null;
    },
    async card() {
      return {
        ask: {
          id: "k_1",
          credentialId: "c_1",
          ownerId: "ou_1",
          requesterId: "ou_1",
          requesterScopeId: "personal:ou_1",
          purpose: "read the repo",
          requestedMode: "once",
          status: "pending",
          createdAt: 1,
          expiresAt: 2,
        },
        service: "GitHub",
        conversation: "this channel",
      };
    },
    async decide() {
      throw new Error("not used");
    },
  };
  core.ackDelivery = async (id) => {
    acks.push(id);
  };
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send(to: string, input: unknown) {
        sends.push({ to, input });
        return { messageId: "om_card" };
      },
    },
  });
  await poller.drain();
  assert.equal(sends.length, 1);
  const sent = sends[0] as { input: { card?: { header?: { title?: { content?: string } } } } };
  assert.equal(sent.input.card?.header?.title?.content, "Credential approval");
  assert.deepEqual(acks, ["d1"]);
});

test("feishu poller renders a deployment access request as a card", async () => {
  const sends: unknown[] = [];
  const core = fakeCore([
    delivery({
      id: "d1",
      destination: {
        type: "feishu",
        target: "oc_1",
        deploymentAccess: { deploymentId: "d_1", requesterId: "ou_1" },
      },
      text: "Alice wants access to your app.",
    }),
  ]);
  const poller = createFeishuDeliveryPoller({
    core,
    channel: {
      async send(to: string, input: unknown) {
        sends.push({ to, input });
        return { messageId: "om_card" };
      },
    },
  });
  await poller.drain();
  assert.equal(sends.length, 1);
  const sent = sends[0] as { input: { card?: { header?: { title?: { content?: string } } } } };
  assert.equal(sent.input.card?.header?.title?.content, "App access request");
});
