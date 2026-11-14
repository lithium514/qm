import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopItem } from "../src/loops/types.ts";
import type { ConnectorTokenSource, FeishuUserClient } from "../src/loops/sources/adapter.ts";
import { feishuAdapter, feishuConversationRef, normalizeFeishuReaction } from "../src/loops/sources/feishu.ts";
import { adapterForItem } from "../src/loops/sources/index.ts";

function item(payload: Record<string, unknown>, proposal?: Record<string, unknown>): LoopItem {
  return {
    id: "i1",
    loopId: "l1",
    sourceKey: "k1",
    source: "feishu",
    sourcePayload: { source: "feishu", title: "Budget", from: "Ada", snippet: "…", receivedAt: 1, ...payload },
    sourceAt: 1,
    status: proposal ? "ready" : "queued",
    attempts: 0,
    runIds: [],
    outputIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...(proposal ? { proposal: { data: proposal, by: "agent" as const, at: 1 } } : {}),
  };
}

function tokens(map: Record<string, string | null>): ConnectorTokenSource {
  return {
    connectorAccessToken: async (host, _principal, accountType) =>
      accountType === "personal" ? (map[host] ?? null) : null,
  };
}

interface FeishuCall {
  api: "send" | "reply" | "react";
  id: string;
  text: string;
  token: string;
}

function feishuSpy(fail?: string): { calls: FeishuCall[]; factory: (token: string) => FeishuUserClient } {
  const calls: FeishuCall[] = [];
  const record = (api: FeishuCall["api"], token: string) => async (id: string, text: string) => {
    calls.push({ api, id, text, token });
    if (fail) throw new Error(fail);
  };
  return {
    calls,
    factory: (token) => ({
      send: record("send", token),
      reply: record("reply", token),
      react: record("react", token),
    }),
  };
}

const dm = item({ feishu: { chatId: "oc_dm", messageId: "om_1", isDirectMessage: true } });
const group = item({ feishu: { chatId: "oc_group", messageId: "om_2", isDirectMessage: false } });
const thread = item({
  feishu: { chatId: "oc_group", messageId: "om_3", threadId: "om_root", isDirectMessage: false },
});

test("Feishu conversation refs keep DMs whole and key groups by thread root", () => {
  assert.equal(feishuConversationRef("oc_dm", "om_1", undefined, true), "oc_dm");
  assert.equal(feishuConversationRef("oc_group", "om_2", undefined, false), "oc_group:om_2");
  assert.equal(feishuConversationRef("oc_group", "om_3", "om_root", false), "oc_group:om_root");
});

test("Feishu parses its source shape and rejects items without routing metadata", () => {
  const parsed = feishuAdapter.parse({
    source: "feishu",
    sourceKey: "chat-1",
    title: "Budget",
    from: "Ada",
    snippet: "thoughts?",
    receivedAt: 1700,
    feishu: { chatId: "oc_group", messageId: "om_2", isDirectMessage: false },
    draft: { body: "sure" },
  });
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.dedupeKey, "oc_group:om_2");
  assert.equal(parsed.sourceAt, 1700);
  assert.equal(parsed.sourcePayload.source, "feishu");
  assert.deepEqual(parsed.proposal?.data, { body: "sure" });
  assert.deepEqual(
    feishuAdapter.parse({ source: "feishu", sourceKey: "k", title: "t", from: "f", snippet: "s", receivedAt: 1 }),
    { error: "feishu items need feishu.chatId, feishu.messageId and feishu.isDirectMessage" },
  );
  assert.deepEqual(feishuAdapter.parse({ source: "feishu", title: "t" }), { error: "from required" });
});

test("Feishu items match incoming conversation events", () => {
  assert.equal(feishuAdapter.matchesEvent(dm, "oc_dm"), true);
  assert.equal(feishuAdapter.matchesEvent(group, "oc_group:om_2"), true);
  assert.equal(feishuAdapter.matchesEvent(thread, "oc_group:om_root"), true);
  assert.equal(feishuAdapter.matchesEvent(thread, "oc_group:om_3"), false);
  assert.equal(feishuAdapter.matchesEvent(dm, "oc_other"), false);
});

test("Feishu sends a DM inline and replies in a group thread", async () => {
  const spy = feishuSpy();
  const deps = { owner: "josh", tokens: tokens({ "open.feishu.cn": "u-token" }), feishuClient: spy.factory };
  assert.deepEqual(await feishuAdapter.act(deps, dm, "send", { body: "on it" }), { ok: true, result: "on it" });
  assert.deepEqual(spy.calls[0], { api: "send", id: "oc_dm", text: "on it", token: "u-token" });
  assert.deepEqual(await feishuAdapter.act(deps, group, "send", { body: "sure" }), { ok: true, result: "sure" });
  assert.deepEqual(spy.calls[1], { api: "reply", id: "om_2", text: "sure", token: "u-token" });
  assert.deepEqual(await feishuAdapter.act(deps, thread, "send", { body: "later" }), { ok: true, result: "later" });
  assert.deepEqual(spy.calls[2], { api: "reply", id: "om_root", text: "later", token: "u-token" });
});

test("Feishu sends the held proposal when the action carries no draft", async () => {
  const spy = feishuSpy();
  const held = item(
    { feishu: { chatId: "oc_group", messageId: "om_2", isDirectMessage: false } },
    { body: "the held draft" },
  );
  const out = await feishuAdapter.act(
    { owner: "josh", tokens: tokens({ "open.feishu.cn": "u" }), feishuClient: spy.factory },
    held,
    "send",
    {},
  );
  assert.equal(out.ok, true);
  assert.equal(spy.calls[0]!.text, "the held draft");
});

test("Feishu reads a missing connector as not_connected", async () => {
  const out = await feishuAdapter.act({ owner: "josh", tokens: tokens({}) }, dm, "send", { body: "x" });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "not_connected");
});

test("Feishu reacts with a Feishu emoji type and annotates the item", async () => {
  const spy = feishuSpy();
  const deps = { owner: "josh", tokens: tokens({ "open.feishu.cn": "u" }), feishuClient: spy.factory };
  const first = await feishuAdapter.act(deps, group, "react", { name: ":+1:" });
  assert.deepEqual(first, {
    ok: true,
    result: ":THUMBSUP:",
    resolves: false,
    payloadPatch: { reactions: ["THUMBSUP"] },
  });
  assert.deepEqual(spy.calls[0], { api: "react", id: "om_2", text: "THUMBSUP", token: "u" });
  assert.equal(normalizeFeishuReaction("eyes"), "EYES");
  assert.equal(normalizeFeishuReaction("not an emoji"), null);
});

test("Feishu refuses unknown actions and empty drafts", async () => {
  const deps = { owner: "josh", tokens: tokens({ "open.feishu.cn": "u" }) };
  const unknown = await feishuAdapter.act(deps, dm, "publish", { body: "x" });
  assert.equal(unknown.ok, false);
  const empty = await feishuAdapter.act(deps, dm, "send", { body: "  " });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "bad_item");
  assert.deepEqual([...feishuAdapter.actions], ["send", "react"]);
});

test("an item resolves to the Feishu adapter", () => {
  assert.equal(adapterForItem(dm)?.id, "feishu");
});
