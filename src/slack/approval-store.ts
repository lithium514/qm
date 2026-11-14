import { swallowAs } from "../util/errors.ts";
import { isSystemActor, type PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !isSystemActor(id) ? id : undefined;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const request = record.request;
    if (!request) return;
    const actorId = approvalDeliveryRecipient(request.actor);
    if (!actorId) return;
    if (request.surface === "feishu") {
      if (!request.deliveryTarget) return;
      await deliveries.enqueue({
        destination: { type: "feishu", target: request.deliveryTarget, commandApprovalId: id },
        text: `Approval needed: ${record.summary ?? record.command}`,
        idempotencyKey: approvalDeliveryKey(id, record),
      });
      return;
    }
    if (request.surface !== "slack") return;
    const origin = request.surfaceOrigin;
    const threadTs = request.conversation?.kind === "dm" ? origin?.replyThread : undefined;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(origin ? { account: { id: origin.author.account, workspace: origin.workspace } } : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries()) await deliver(id, record);
    },
  };
}
