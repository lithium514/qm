import type { InteractiveCard } from "@larksuiteoapi/node-sdk";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import { headSlice } from "../util/text.ts";
import { errMessage } from "../util/errors.ts";
import { buildFeishuCard, type FeishuCardButton, type FeishuCardTemplate } from "./cards.ts";
import type { FeishuCore, StoredFeishuApproval } from "./core.ts";
import type { FeishuCardResponse } from "./handler.ts";
import type { FeishuCardAction, FeishuQmAction } from "./payloads.ts";

const COMMAND_MAX = 1_800;
const DETAIL_MAX = 500;
const REASON_MAX = 300;

export type FeishuApprovalDecision = "once" | "session" | "always" | "deny";

const DECISION_LABEL: Record<FeishuApprovalDecision, string> = {
  once: "Allowed once",
  session: "Allowed for this conversation",
  always: "Allowed always",
  deny: "Denied",
};

function approvalButtons(stored: StoredFeishuApproval): FeishuCardButton[] {
  const requestId = stored.requestId;
  return [
    { label: "Allow once", action: "approval", id: requestId, value: "once", type: "primary" },
    ...(stored.grantModes?.session === false
      ? []
      : [{ label: "Allow session", action: "approval", id: requestId, value: "session" }]),
    ...(stored.grantModes?.always === false
      ? []
      : [{ label: "Allow always", action: "approval", id: requestId, value: "always" }]),
    { label: "Deny", action: "approval", id: requestId, value: "deny", type: "danger" },
  ];
}

function commandText(command: string): string {
  return headSlice(command, COMMAND_MAX).replaceAll("`", "'");
}

export function approvalCard(stored: StoredFeishuApproval): InteractiveCard {
  const lines: string[] = [];
  if (stored.kind === "input") lines.push("**My security screen flagged part of this message. Allow it?**");
  else lines.push("**Approval needed before I can run this.**");
  if (stored.summary && stored.summary !== stored.command) lines.push(headSlice(stored.summary, DETAIL_MAX));
  if (stored.purpose) lines.push(`**Why:** ${headSlice(stored.purpose, DETAIL_MAX)}`);
  if (stored.kind !== "input") lines.push(`**Command:** \`${commandText(stored.command)}\``);
  if (stored.reason) lines.push(`**Flagged as:** ${headSlice(stored.reason, REASON_MAX)}`);
  return buildFeishuCard({
    title: stored.kind === "input" ? "Flagged message" : "Approval needed",
    body: lines.join("\n"),
    buttons: approvalButtons(stored),
    template: "orange",
  });
}

function settledLabel(view: KeychainApprovalView): string {
  if (view.ask.status !== "approved") return "Denied.";
  return view.mode === "standing" ? "Approved — ongoing access." : "Approved — one-time access.";
}

function keychainTemplate(pending: boolean, approved: boolean): FeishuCardTemplate {
  if (pending) return "orange";
  return approved ? "green" : "grey";
}

export function keychainCard(view: KeychainApprovalView): InteractiveCard {
  const pending = view.ask.status === "pending";
  const duration = view.ask.requestedMode === "once" ? "one-time access" : "ongoing access";
  const body = pending
    ? `**Approval needed.** Use your **${view.service}** credential in **${view.conversation}** (${duration}).`
    : `**${settledLabel(view)}**`;
  const allowOnce: FeishuCardButton = {
    label: "Allow once",
    action: "keychain",
    id: view.ask.id,
    value: "once",
    type: "primary",
  };
  const allowStanding: FeishuCardButton = {
    label: "Allow",
    action: "keychain",
    id: view.ask.id,
    value: "standing",
    ...(view.ask.requestedMode === "once" ? {} : { type: "primary" as const }),
  };
  return buildFeishuCard({
    title: pending ? "Credential approval" : "Credential decision",
    body,
    ...(pending
      ? {
          buttons: [
            ...(view.ask.requestedMode === "once" ? [allowOnce, allowStanding] : [allowStanding, allowOnce]),
            { label: "Deny", action: "keychain", id: view.ask.id, value: "deny", type: "danger" },
          ],
        }
      : {}),
    template: keychainTemplate(pending, view.ask.status === "approved"),
  });
}

function keychainDecision(value: string | undefined): "once" | "standing" | "deny" | undefined {
  return value === "once" || value === "standing" || value === "deny" ? value : undefined;
}

export function createFeishuKeychainHandler(deps: {
  core: FeishuCore;
}): (action: FeishuCardAction, parsed: FeishuQmAction) => Promise<FeishuCardResponse | undefined> {
  return async (action, parsed) => {
    const id = parsed.id;
    const decision = keychainDecision(parsed.value);
    if (!id || !decision) return { toast: { type: "error", content: "Invalid credential approval action." } };
    const approvals = deps.core.keychainApprovals;
    if (!approvals) return { toast: { type: "error", content: "Credential approvals are unavailable." } };
    try {
      const view = await approvals.decide(id, { externalId: action.operatorOpenId }, decision);
      return {
        toast: {
          type: decision === "deny" ? "info" : "success",
          content: decision === "deny" ? "Denied." : "Approved.",
        },
        card: keychainCard(view),
      };
    } catch (error) {
      return { toast: { type: "error", content: `Couldn't complete this approval: ${errMessage(error)}` } };
    }
  };
}

export interface FeishuDeployRequest {
  deploymentId: string;
  requesterId: string;
}

export function deployAccessCard(request: FeishuDeployRequest, text: string): InteractiveCard {
  const value = JSON.stringify(request);
  return buildFeishuCard({
    title: "App access request",
    body: headSlice(text, 3_000),
    buttons: [
      { label: "Approve", action: "deploy", id: "approve", value, type: "primary" },
      { label: "Decline", action: "deploy", id: "decline", value, type: "danger" },
    ],
    template: "orange",
  });
}

export function createFeishuDeployHandler(deps: {
  core: FeishuCore;
}): (action: FeishuCardAction, parsed: FeishuQmAction) => Promise<FeishuCardResponse | undefined> {
  return async (action, parsed) => {
    const value = parsed.value;
    const decision = parsed.id;
    if (!value || (decision !== "approve" && decision !== "decline"))
      return { toast: { type: "error", content: "Invalid app access action." } };
    const decide = deps.core.decideDeploymentAccess;
    if (!decide) return { toast: { type: "error", content: "App access decisions are unavailable." } };
    try {
      const text = await decide(value, { externalId: action.operatorOpenId }, decision === "approve");
      return {
        toast: { type: decision === "approve" ? "success" : "info", content: text },
        card: buildFeishuCard({
          title: "App access",
          body: text,
          template: decision === "approve" ? "green" : "grey",
        }),
      };
    } catch (error) {
      return { toast: { type: "error", content: `Couldn't complete that: ${errMessage(error)}` } };
    }
  };
}

export function approvalDecisionCard(stored: StoredFeishuApproval, decision: FeishuApprovalDecision): InteractiveCard {
  return buildFeishuCard({
    title: "Approval decided",
    body: `**${DECISION_LABEL[decision]}** · \`${commandText(stored.command)}\``,
    template: decision === "deny" ? "grey" : "green",
  });
}

function decisionOf(value: string | undefined): FeishuApprovalDecision | undefined {
  return value === "once" || value === "session" || value === "always" || value === "deny" ? value : undefined;
}

export function createFeishuApprovalHandler(deps: {
  core: FeishuCore;
}): (action: FeishuCardAction, parsed: FeishuQmAction) => Promise<FeishuCardResponse | undefined> {
  return async (action, parsed) => {
    const requestId = parsed.id;
    const decision = decisionOf(parsed.value);
    if (!requestId || !decision) return { toast: { type: "error", content: "Invalid approval action." } };
    let stored: StoredFeishuApproval | null;
    try {
      stored = await deps.core.getApproval(requestId);
    } catch (error) {
      return { toast: { type: "error", content: `Couldn't check that approval: ${errMessage(error)}` } };
    }
    if (!stored) return { toast: { type: "error", content: "That approval request expired." } };
    const request = stored.request;
    if (!request) return { toast: { type: "error", content: "That approval request expired." } };
    if (request.actor.externalId !== action.operatorOpenId)
      return { toast: { type: "error", content: "Only the person who requested this can decide." } };
    const scope = decision === "deny" ? undefined : decision;
    const approved = scope !== undefined;
    const {
      surface: _surface,
      async: _async,
      idempotencyKey: _idempotencyKey,
      redeliveryKey: _redeliveryKey,
      approval: _approval,
      ...turn
    } = request;
    try {
      await deps.core.turn({
        ...turn,
        surface: "feishu",
        async: true,
        approval: { requestId, approved, ...(scope ? { scope } : {}) },
      });
    } catch (error) {
      return { toast: { type: "error", content: `Couldn't continue: ${errMessage(error)}` } };
    }
    return {
      toast: {
        type: approved ? "success" : "info",
        content: approved ? "Approved — continuing." : "Denied.",
      },
      card: approvalDecisionCard(stored, decision),
    };
  };
}
