import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEISHU_SURFACE,
  feishuContainerRef,
  feishuConversationKind,
  feishuDeliveryTarget,
  feishuThreadRef,
  isFeishuRef,
  parseFeishuDeliveryTarget,
  parseFeishuRef,
} from "../src/feishu/ids.ts";

test("feishu refs use the fs namespace", () => {
  assert.equal(FEISHU_SURFACE, "feishu");
  assert.equal(feishuContainerRef("oc_1"), "fs:oc_1");
  assert.equal(feishuThreadRef("oc_1"), "fs:oc_1");
  assert.equal(feishuThreadRef("oc_1", "om_2"), "fs:oc_1:om_2");
});

test("parseFeishuRef round-trips and rejects other surfaces", () => {
  assert.deepEqual(parseFeishuRef("fs:oc_1"), { chatId: "oc_1" });
  assert.deepEqual(parseFeishuRef("fs:oc_1:om_2"), { chatId: "oc_1", threadId: "om_2" });
  assert.equal(parseFeishuRef("dm:oc_1"), undefined);
  assert.equal(parseFeishuRef("fs:"), undefined);
  assert.equal(parseFeishuRef("fs:oc_1:om_2:extra"), undefined);
  assert.equal(parseFeishuRef(undefined), undefined);
});

test("isFeishuRef is false for legacy Slack refs", () => {
  assert.equal(isFeishuRef("fs:oc_1"), true);
  assert.equal(isFeishuRef("ch:oc_1:om_2"), false);
  assert.equal(isFeishuRef("dm:oc_1"), false);
});

test("feishuConversationKind maps p2p to dm", () => {
  assert.equal(feishuConversationKind("p2p"), "dm");
  assert.equal(feishuConversationKind("group"), "channel");
  assert.equal(feishuConversationKind(undefined), "channel");
});

test("feishu ids reject colon injection", () => {
  assert.throws(() => feishuContainerRef("oc:1"), /invalid Feishu chat id/);
  assert.throws(() => feishuThreadRef("oc_1", "om:2"), /invalid Feishu thread id/);
});

test("feishu delivery targets carry the optional thread", () => {
  assert.equal(feishuDeliveryTarget("oc_1"), "oc_1");
  assert.equal(feishuDeliveryTarget("oc_1", "om_2"), "oc_1:om_2");
  assert.deepEqual(parseFeishuDeliveryTarget("oc_1"), { chatId: "oc_1" });
  assert.deepEqual(parseFeishuDeliveryTarget("oc_1:om_2"), { chatId: "oc_1", threadId: "om_2" });
  assert.equal(parseFeishuDeliveryTarget("a:b:c"), undefined);
  assert.equal(parseFeishuDeliveryTarget(undefined), undefined);
  assert.throws(() => feishuDeliveryTarget("oc:1"), /invalid Feishu chat id/);
});
