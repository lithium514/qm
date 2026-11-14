import type { InteractiveCard, InteractiveCardActionItem } from "@larksuiteoapi/node-sdk";
import { headSlice } from "../util/text.ts";
import { qmActionValue } from "./payloads.ts";

export type FeishuCardTemplate =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey";

export const FEISHU_CARD_BODY_MAX = 20_000;
const FEISHU_CARD_TITLE_MAX = 120;
const FEISHU_CARD_BUTTON_MAX = 4;

export interface FeishuCardButton {
  label: string;
  action: string;
  id?: string;
  value?: string;
  type?: "default" | "primary" | "danger";
}

export interface FeishuCardInput {
  title: string;
  body: string;
  buttons?: readonly FeishuCardButton[];
  template?: FeishuCardTemplate;
  footer?: string;
}

export function buildFeishuCard(input: FeishuCardInput): InteractiveCard {
  const buttons = (input.buttons ?? [])
    .filter((b) => b.label.trim() && b.action.trim())
    .slice(0, FEISHU_CARD_BUTTON_MAX);
  const actions: InteractiveCardActionItem[] = buttons.map((button) => ({
    tag: "button",
    text: { tag: "plain_text", content: headSlice(button.label, 60) },
    type: button.type ?? "default",
    value: qmActionValue(button.action, button.id, button.value),
  }));
  const elements: NonNullable<InteractiveCard["elements"]> = [
    { tag: "div", text: { tag: "lark_md", content: headSlice(input.body, FEISHU_CARD_BODY_MAX) } },
  ];
  if (actions.length) elements.push({ tag: "action", actions, layout: "flow" });
  const footer = input.footer?.trim();
  if (footer) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: headSlice(footer, 400) }] });
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: headSlice(input.title, FEISHU_CARD_TITLE_MAX) },
      template: input.template ?? "blue",
    },
    elements,
  };
}
