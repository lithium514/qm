import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCardAction,
  parseEventEnvelope,
  parseMessageRecall,
  parseQmAction,
  parseReactionEvent,
  qmActionValue,
} from "../src/feishu/payloads.ts";

test("parseEventEnvelope unwraps the v2 schema", () => {
  const envelope = parseEventEnvelope({
    schema: "2.0",
    header: { event_id: "evt_1", event_type: "im.message.receive_v1", tenant_key: "t_1", app_id: "cli_1" },
    event: { hello: "world" },
  });
  assert.equal(envelope?.eventId, "evt_1");
  assert.equal(envelope?.eventType, "im.message.receive_v1");
  assert.equal(envelope?.tenantKey, "t_1");
  assert.equal(envelope?.appId, "cli_1");
  assert.deepEqual(envelope?.event, { hello: "world" });
});

test("parseCardAction reads the v2 context and action value", () => {
  const action = parseCardAction({
    schema: "2.0",
    header: { event_id: "evt_1" },
    event: {
      operator: { open_id: "ou_1", user_id: "u_1" },
      action: { tag: "button", name: "approve", value: { qm: "approval", id: "a_1", value: "allow_once" } },
      context: { open_message_id: "om_1", open_chat_id: "oc_1" },
    },
  });
  assert.deepEqual(action, {
    eventId: "evt_1",
    operatorOpenId: "ou_1",
    operatorUserId: "u_1",
    messageId: "om_1",
    chatId: "oc_1",
    actionTag: "button",
    actionName: "approve",
    value: { qm: "approval", id: "a_1", value: "allow_once" },
  });
});

test("parseCardAction rejects payloads without an operator or message", () => {
  assert.equal(parseCardAction({ event: { action: { value: {} } } }), undefined);
  assert.equal(parseCardAction({ event: { operator: { open_id: "ou_1" }, action: { value: {} } } }), undefined);
  assert.equal(parseCardAction(undefined), undefined);
});

test("parseQmAction and qmActionValue round-trip", () => {
  assert.deepEqual(parseQmAction(qmActionValue("approval", "a_1", "deny")), {
    action: "approval",
    id: "a_1",
    value: "deny",
  });
  assert.deepEqual(parseQmAction({ qm: "deploy" }), { action: "deploy" });
  assert.equal(parseQmAction({ id: "no-action" }), undefined);
  assert.equal(parseQmAction("qm"), undefined);
});

test("parseReactionEvent reads added and removed events", () => {
  const body = {
    schema: "2.0",
    header: { event_id: "evt_r" },
    event: {
      message_id: "om_1",
      reaction_type: { emoji_type: "THUMBSUP" },
      user_id: { open_id: "ou_1" },
      action_time: "1723000000000",
    },
  };
  const added = parseReactionEvent(body, "added");
  assert.equal(added?.messageId, "om_1");
  assert.equal(added?.emojiType, "THUMBSUP");
  assert.equal(added?.operatorOpenId, "ou_1");
  assert.equal(added?.action, "added");
  assert.equal(added?.actionTime, 1723000000000);
  assert.equal(parseReactionEvent(body, "removed")?.action, "removed");
  assert.equal(parseReactionEvent({ event: { message_id: "om_1" } }, "added"), undefined);
});

test("parseMessageRecall reads the recall event", () => {
  const recall = parseMessageRecall({
    schema: "2.0",
    header: { event_id: "evt_d" },
    event: {
      message_id: "om_1",
      chat_id: "oc_1",
      recall_time: "1723000000000",
      operator_id: { open_id: "ou_1" },
    },
  });
  assert.deepEqual(recall, {
    eventId: "evt_d",
    messageId: "om_1",
    chatId: "oc_1",
    recallTime: 1723000000000,
    operatorOpenId: "ou_1",
  });
});
