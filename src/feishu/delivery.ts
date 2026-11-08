import { LarkChannelError, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import type { Delivery } from "../types.ts";
import { approvalCard, deployAccessCard, keychainCard } from "./approval.ts";
import type { FeishuCore } from "./core.ts";
import { parseFeishuDeliveryTarget, type FeishuRef } from "./ids.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CLAIM_MS = 30_000;
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  "format_error",
  "target_revoked",
  "permission_denied",
  "ssrf_blocked",
]);

export interface FeishuDeliveryPoller {
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<number>;
}

function sendOptions(target: FeishuRef): { replyTo: string; replyInThread: boolean } | undefined {
  return target.threadId ? { replyTo: target.threadId, replyInThread: true } : undefined;
}

async function deliverAttachments(
  channel: Pick<LarkChannel, "send">,
  core: FeishuCore,
  target: FeishuRef,
  delivery: Delivery,
): Promise<void> {
  for (const attachment of delivery.attachments ?? []) {
    const bytes = await core.readBlob(attachment.blobId);
    const options = sendOptions(target);
    if (attachment.mimetype.startsWith("image/")) {
      await channel.send(target.chatId, { image: { source: bytes } }, options);
    } else {
      await channel.send(target.chatId, { file: { source: bytes, fileName: attachment.name } }, options);
    }
  }
}

async function deliverOne(channel: Pick<LarkChannel, "send">, core: FeishuCore, delivery: Delivery): Promise<void> {
  const target = parseFeishuDeliveryTarget(delivery.destination.target);
  if (!target) {
    await core.failDelivery(delivery.id, `invalid Feishu delivery target: ${delivery.destination.target}`);
    return;
  }
  const started = Date.now();
  try {
    if (delivery.destination.commandApprovalId) {
      const approval = await core.getApproval(delivery.destination.commandApprovalId);
      if (approval) {
        await channel.send(target.chatId, { card: approvalCard(approval) }, sendOptions(target));
      }
      await core.ackDelivery(delivery.id, Date.now() - started);
      return;
    }
    if (delivery.destination.keychainAskId) {
      const view = await core.keychainApprovals?.card(delivery.destination.keychainAskId);
      if (view) await channel.send(target.chatId, { card: keychainCard(view) }, sendOptions(target));
      await core.ackDelivery(delivery.id, Date.now() - started);
      return;
    }
    if (delivery.destination.deploymentAccess) {
      await channel.send(
        target.chatId,
        { card: deployAccessCard(delivery.destination.deploymentAccess, delivery.text) },
        sendOptions(target),
      );
      await core.ackDelivery(delivery.id, Date.now() - started);
      return;
    }
    if (delivery.text.trim() || !delivery.attachments?.length) {
      await channel.send(target.chatId, { markdown: delivery.text }, sendOptions(target));
    }
    await deliverAttachments(channel, core, target, delivery);
    await core.ackDelivery(delivery.id, Date.now() - started);
  } catch (error) {
    const permanent = error instanceof LarkChannelError && PERMANENT_ERRORS.has(error.code);
    if (permanent) {
      await core.failDelivery(delivery.id, errMessage(error));
      return;
    }
    reportFailure("feishu: delivery", error, `delivery=${delivery.id}`);
  }
}

export function createFeishuDeliveryPoller(opts: {
  core: FeishuCore;
  channel: Pick<LarkChannel, "send">;
  leaderLease?: LeaderLease;
  intervalMs?: number;
  claimMs?: number;
}): FeishuDeliveryPoller {
  const claimMs = opts.claimMs ?? DEFAULT_CLAIM_MS;
  const drain = async (): Promise<number> => {
    const deliver = async (): Promise<number> => {
      const rows = await opts.core.pendingDeliveries("feishu", claimMs);
      for (const delivery of rows) await deliverOne(opts.channel, opts.core, delivery);
      return rows.length;
    };
    if (!opts.leaderLease) return deliver();
    return (await opts.leaderLease.hold("feishu:delivery-dispatch", deliver)) ?? 0;
  };
  let sweeper: Sweeper | undefined;
  return {
    drain,
    start() {
      sweeper ??= createSweeper(() => drain(), opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, {
        label: "feishu delivery poller",
        immediate: true,
      });
      sweeper.start();
    },
    async stop() {
      await sweeper?.stop();
      sweeper = undefined;
    },
  };
}
