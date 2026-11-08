import { test } from "node:test";
import assert from "node:assert/strict";
import type { InteractiveCard } from "@larksuiteoapi/node-sdk";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import type { KeychainApprovalView } from "../src/credentials/keychain-approval.ts";
import type { TurnRequest } from "../src/types.ts";
import type { FeishuCore, StoredFeishuApproval } from "../src/feishu/core.ts";
import {
  approvalCard,
  approvalDecisionCard,
  createFeishuApprovalHandler,
  createFeishuDeployHandler,
  createFeishuKeychainHandler,
  deployAccessCard,
  keychainCard,
} from "../src/feishu/approval.ts";
import type { FeishuCardAction } from "../src/feishu/payloads.ts";

function stored(overrides: Partial<StoredFeishuApproval> = {}): StoredFeishuApproval {
  return {
    requestId: "a_1",
    command: "rm -rf build",
    reason: "destructive command",
    request: {
      surface: "feishu",
      actor: { externalId: "ou_1" },
      conversation: { kind: "channel", threadRef: "fs:oc_1:om_1", audience: [] },
      deliveryTarget: "oc_1:om_1",
      text: "clean the build",
      async: true,
      redeliveryKey: "feishu:cli_1:om_1",
    } as TurnRequest,
    ...overrides,
  };
}

function action(overrides: Partial<FeishuCardAction> = {}): FeishuCardAction {
  return {
    operatorOpenId: "ou_1",
    messageId: "om_card",
    chatId: "oc_1",
    value: { qm: "approval", id: "a_1", value: "once" },
    ...overrides,
  };
}

function cardButtons(card: InteractiveCard): Array<Record<string, unknown>> {
  const element = card.elements?.find((item) => item.tag === "action");
  return element?.tag === "action" ? (element.actions as unknown as Array<Record<string, unknown>>) : [];
}

test("approvalCard renders the command and respects grant modes", () => {
  const card = approvalCard(stored({ grantModes: { session: false, always: true } }));
  assert.deepEqual(card.header?.title, { tag: "plain_text", content: "Approval needed" });
  const body = card.elements?.[0];
  assert.equal(body?.tag, "div");
  assert.match(body?.tag === "div" && body.text.tag === "lark_md" ? (body.text.content ?? "") : "", /rm -rf build/);
  assert.match(
    body?.tag === "div" && body.text.tag === "lark_md" ? (body.text.content ?? "") : "",
    /destructive command/,
  );
  const buttons = cardButtons(card);
  assert.deepEqual(
    buttons.map((button) => [button.text, button.value]),
    [
      [
        { tag: "plain_text", content: "Allow once" },
        { qm: "approval", id: "a_1", value: "once" },
      ],
      [
        { tag: "plain_text", content: "Allow always" },
        { qm: "approval", id: "a_1", value: "always" },
      ],
      [
        { tag: "plain_text", content: "Deny" },
        { qm: "approval", id: "a_1", value: "deny" },
      ],
    ],
  );
});

test("approvalCard hides session and always when the grant modes forbid them", () => {
  const card = approvalCard(stored({ grantModes: { session: false, always: false } }));
  assert.deepEqual(
    cardButtons(card).map((button) => button.value),
    [
      { qm: "approval", id: "a_1", value: "once" },
      { qm: "approval", id: "a_1", value: "deny" },
    ],
  );
});

test("approvalDecisionCard settles without buttons", () => {
  const card = approvalDecisionCard(stored(), "deny");
  assert.equal(card.header?.title.content, "Approval decided");
  assert.equal(cardButtons(card).length, 0);
  const body = card.elements?.[0];
  assert.match(body?.tag === "div" && body.text.tag === "lark_md" ? (body.text.content ?? "") : "", /Denied/);
});

test("approval handler re-runs the stored turn with the selected scope", async () => {
  const turns: TurnRequest[] = [];
  const core: FeishuCore = {
    async turn(request) {
      turns.push(request);
      return { status: "queued", runId: "run_1" };
    },
    async getApproval() {
      return stored();
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuApprovalHandler({ core });
  const result = await handler(action(), { action: "approval", id: "a_1", value: "once" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.surface, "feishu");
  assert.equal(turns[0]!.async, true);
  assert.deepEqual(turns[0]!.approval, { requestId: "a_1", approved: true, scope: "once" });
  assert.equal(turns[0]!.redeliveryKey, undefined);
  assert.deepEqual(result?.toast, { type: "success", content: "Approved — continuing." });
  assert.equal((result?.card as InteractiveCard | undefined)?.header?.title.content, "Approval decided");
});

test("approval handler denies without a scope", async () => {
  const turns: TurnRequest[] = [];
  const core: FeishuCore = {
    async turn(request) {
      turns.push(request);
      return { status: "queued", runId: "run_1" };
    },
    async getApproval() {
      return stored();
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuApprovalHandler({ core });
  await handler(action(), { action: "approval", id: "a_1", value: "deny" });
  assert.deepEqual(turns[0]!.approval, { requestId: "a_1", approved: false });
});

test("approval handler rejects anyone but the requester", async () => {
  let turnCalled = false;
  const core: FeishuCore = {
    async turn() {
      turnCalled = true;
      return { status: "queued", runId: "run_1" };
    },
    async getApproval() {
      return stored();
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuApprovalHandler({ core });
  const result = await handler(action({ operatorOpenId: "ou_2" }), {
    action: "approval",
    id: "a_1",
    value: "once",
  });
  assert.equal(turnCalled, false);
  assert.deepEqual(result?.toast, {
    type: "error",
    content: "Only the person who requested this can decide.",
  });
});

test("approval handler reports an expired or unavailable approval", async () => {
  const core: FeishuCore = {
    async turn() {
      throw new Error("must not run");
    },
    async getApproval() {
      return null;
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuApprovalHandler({ core });
  const expired = await handler(action(), { action: "approval", id: "a_1", value: "once" });
  assert.deepEqual(expired?.toast, { type: "error", content: "That approval request expired." });
  core.getApproval = async () => {
    throw new Error("database down");
  };
  const failed = await handler(action(), { action: "approval", id: "a_1", value: "once" });
  assert.equal(failed?.toast?.type, "error");
  assert.match(failed?.toast?.content ?? "", /database down/);
});

function keychainView(overrides: Partial<KeychainApprovalView> = {}): KeychainApprovalView {
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
    } as KeychainAsk,
    service: "GitHub",
    conversation: "this channel",
    ...overrides,
  };
}

test("keychainCard offers once, standing, and deny for a one-time request", () => {
  const card = keychainCard(keychainView());
  assert.deepEqual(
    cardButtons(card).map((button) => [button.text, button.value, button.type]),
    [
      [{ tag: "plain_text", content: "Allow once" }, { qm: "keychain", id: "k_1", value: "once" }, "primary"],
      [{ tag: "plain_text", content: "Allow" }, { qm: "keychain", id: "k_1", value: "standing" }, "default"],
      [{ tag: "plain_text", content: "Deny" }, { qm: "keychain", id: "k_1", value: "deny" }, "danger"],
    ],
  );
});

test("keychain handler decides as the clicker and returns the settled card", async () => {
  const decisions: Array<{ id: string; actor: unknown; decision: string }> = [];
  const core: FeishuCore = {
    async turn() {
      throw new Error("not used");
    },
    async getApproval() {
      return null;
    },
    keychainApprovals: {
      async get() {
        return null;
      },
      async card() {
        return keychainView();
      },
      async decide(id, actor, decision) {
        decisions.push({ id, actor, decision });
        return keychainView({ ask: { ...keychainView().ask, status: "approved" } as KeychainAsk, mode: "once" });
      },
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuKeychainHandler({ core });
  const result = await handler(action(), { action: "keychain", id: "k_1", value: "once" });
  assert.deepEqual(decisions, [{ id: "k_1", actor: { externalId: "ou_1" }, decision: "once" }]);
  assert.deepEqual(result?.toast, { type: "success", content: "Approved." });
  assert.equal(cardButtons(result?.card as InteractiveCard).length, 0);
});

test("keychain handler reports unavailable approvals", async () => {
  const core: FeishuCore = {
    async turn() {
      throw new Error("not used");
    },
    async getApproval() {
      return null;
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuKeychainHandler({ core });
  const result = await handler(action(), { action: "keychain", id: "k_1", value: "once" });
  assert.deepEqual(result?.toast, { type: "error", content: "Credential approvals are unavailable." });
});

test("deployAccessCard carries the request on both decisions", () => {
  const card = deployAccessCard({ deploymentId: "d_1", requesterId: "ou_1" }, "Alice wants access to your app.");
  assert.equal(card.header?.title.content, "App access request");
  const value = JSON.stringify({ deploymentId: "d_1", requesterId: "ou_1" });
  assert.deepEqual(
    cardButtons(card).map((button) => [button.text, button.value, button.type]),
    [
      [{ tag: "plain_text", content: "Approve" }, { qm: "deploy", id: "approve", value }, "primary"],
      [{ tag: "plain_text", content: "Decline" }, { qm: "deploy", id: "decline", value }, "danger"],
    ],
  );
});

test("deploy handler calls the core decision with the clicker", async () => {
  const decisions: Array<{ value: string; actor: unknown; approve: boolean }> = [];
  const core: FeishuCore = {
    async turn() {
      throw new Error("not used");
    },
    async getApproval() {
      return null;
    },
    async decideDeploymentAccess(value, actor, approve) {
      decisions.push({ value, actor, approve });
      return "Approved. ou_1 can now open the app.";
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuDeployHandler({ core });
  const value = JSON.stringify({ deploymentId: "d_1", requesterId: "ou_1" });
  const result = await handler(action(), { action: "deploy", id: "approve", value });
  assert.deepEqual(decisions, [{ value, actor: { externalId: "ou_1" }, approve: true }]);
  assert.deepEqual(result?.toast, { type: "success", content: "Approved. ou_1 can now open the app." });
  assert.equal((result?.card as InteractiveCard | undefined)?.header?.title.content, "App access");
});

test("deploy handler reports unavailable decisions", async () => {
  const core: FeishuCore = {
    async turn() {
      throw new Error("not used");
    },
    async getApproval() {
      return null;
    },
    async pendingDeliveries() {
      return [];
    },
    async ackDelivery() {},
    async failDelivery() {
      return null;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 1 };
    },
    async readBlob() {
      return Buffer.from("");
    },
  };
  const handler = createFeishuDeployHandler({ core });
  const result = await handler(action(), {
    action: "deploy",
    id: "approve",
    value: JSON.stringify({ deploymentId: "d_1", requesterId: "ou_1" }),
  });
  assert.deepEqual(result?.toast, { type: "error", content: "App access decisions are unavailable." });
});
