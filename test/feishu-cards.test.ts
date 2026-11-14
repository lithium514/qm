import { test } from "node:test";
import assert from "node:assert/strict";
import { FEISHU_CARD_BODY_MAX, buildFeishuCard } from "../src/feishu/cards.ts";

test("buildFeishuCard renders a header, markdown body, and qm action buttons", () => {
  const card = buildFeishuCard({
    title: "Approve command",
    body: "Run `rm -rf build`?",
    buttons: [
      { label: "Allow once", action: "approval", id: "a_1", value: "allow_once", type: "primary" },
      { label: "Deny", action: "approval", id: "a_1", value: "deny", type: "danger" },
    ],
    footer: "Requested by Alice",
  });
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "Approve command" }, template: "blue" });
  assert.deepEqual(card.config, { update_multi: true, wide_screen_mode: true });
  assert.deepEqual(card.elements?.[0], {
    tag: "div",
    text: { tag: "lark_md", content: "Run `rm -rf build`?" },
  });
  assert.deepEqual(card.elements?.[1], {
    tag: "action",
    layout: "flow",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "Allow once" },
        type: "primary",
        value: { qm: "approval", id: "a_1", value: "allow_once" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Deny" },
        type: "danger",
        value: { qm: "approval", id: "a_1", value: "deny" },
      },
    ],
  });
  assert.deepEqual(card.elements?.[2], {
    tag: "note",
    elements: [{ tag: "plain_text", content: "Requested by Alice" }],
  });
});

test("buildFeishuCard omits the action element without buttons", () => {
  const card = buildFeishuCard({ title: "Status", body: "Working" });
  assert.deepEqual(card.elements, [{ tag: "div", text: { tag: "lark_md", content: "Working" } }]);
});

test("buildFeishuCard caps buttons and refuses blank ones", () => {
  const card = buildFeishuCard({
    title: "Status",
    body: "Working",
    buttons: [
      { label: "  ", action: "approval" },
      { label: "One", action: "approval" },
      { label: "Two", action: "approval" },
      { label: "Three", action: "approval" },
      { label: "Four", action: "approval" },
      { label: "Five", action: "approval" },
    ],
  });
  const action = card.elements?.[1];
  assert.equal(action?.tag, "action");
  assert.equal(action?.tag === "action" ? action.actions.length : 0, 4);
});

test("buildFeishuCard clips oversized bodies", () => {
  const card = buildFeishuCard({ title: "Long", body: "x".repeat(FEISHU_CARD_BODY_MAX + 100) });
  const first = card.elements?.[0];
  assert.equal(first?.tag, "div");
  assert.equal(
    first?.tag === "div" && first.text.tag === "lark_md" ? (first.text.content?.length ?? 0) : 0,
    FEISHU_CARD_BODY_MAX,
  );
});
