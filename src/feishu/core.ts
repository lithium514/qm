import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { App } from "../api/app.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import type { DirectoryMember, DirectoryStore } from "../directory/directory-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ConversationEvent } from "../loops/sources/adapter.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { decideDeploymentAccess } from "../slack/deploy-access.ts";
import type { CachedMessage, IngestEvent, ReadMessagesOpts } from "../surface-cache/types.ts";
import type { ActorAssertion, Delivery, TurnRequest, TurnResult } from "../types.ts";

export interface StoredFeishuApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  request?: TurnRequest;
  createdAt?: number;
}

export interface FeishuCore {
  turn(request: TurnRequest): Promise<TurnResult>;
  hasSession?(threadRef: string): Promise<boolean>;
  getApproval(requestId: string): Promise<StoredFeishuApproval | null>;
  upsertMember?(member: DirectoryMember): Promise<void>;
  ingestSurfaceEvents?(events: IngestEvent[], self?: { name?: string; mentionId?: string }): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  keychainApprovals?: KeychainApprovals;
  decideDeploymentAccess?(value: string, actor: ActorAssertion, approve: boolean): Promise<string>;
  pendingDeliveries(type: string, claimMs?: number): Promise<Delivery[]>;
  ackDelivery(id: string, providerApiMs?: number): Promise<void>;
  failDelivery(id: string, reason: string): Promise<Delivery | null>;
  stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
  resolvePrincipal?(externalId: string): string;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

export function createFeishuCore(
  app: App,
  blobTransfer: BlobTransferStore,
  sessions?: SessionStore,
  keychainApprovals?: KeychainApprovals,
  identity?: IdentityService,
  directory?: DirectoryStore,
  inboxEvent?: (event: ConversationEvent) => Promise<void>,
): FeishuCore {
  const upsertMembers = directory?.upsertMembers?.bind(directory);
  return {
    turn(request) {
      return app.turn(request);
    },
    ...(keychainApprovals ? { keychainApprovals } : {}),
    ...(inboxEvent
      ? {
          async inboxEvent(event: ConversationEvent) {
            await inboxEvent(event);
          },
        }
      : {}),
    ...(upsertMembers
      ? {
          async upsertMember(member: DirectoryMember) {
            await upsertMembers([member]);
          },
        }
      : {}),
    async ingestSurfaceEvents(events, self) {
      if (events.length) await app.ingestSurfaceEvents(events, "feishu", self);
    },
    async readSurfaceMessages(container, opts) {
      return app.readSurfaceMessages(container, { ...opts, noFallback: true });
    },
    async decideDeploymentAccess(value, actor, approve) {
      if (!identity) throw new Error("Deployment access decisions are unavailable.");
      return decideDeploymentAccess(app, identity, value, actor, approve);
    },
    ...(sessions
      ? {
          async hasSession(threadRef: string) {
            return Boolean(await sessions.getByThread(threadRef));
          },
        }
      : {}),
    async getApproval(requestId) {
      const record = await app.getApproval(requestId);
      if (!record) return null;
      return {
        requestId: record.requestId,
        command: record.command,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.grantModes !== undefined ? { grantModes: record.grantModes } : {}),
        ...(record.request !== undefined ? { request: record.request } : {}),
        ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
      };
    },
    pendingDeliveries(type, claimMs) {
      return app.pendingDeliveries(type, claimMs);
    },
    ackDelivery(id, providerApiMs) {
      return app.ackDelivery(id, providerApiMs);
    },
    failDelivery(id, reason) {
      return app.failDelivery(id, reason);
    },
    async stageBlob(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const info = await blobTransfer.put(Readable.from([Buffer.from(bytes)]), {
        maxBytes: MAX_BLOB_BYTES,
        expectedSha256: sha256,
      });
      return { blobId: info.blobId, sizeBytes: info.sizeBytes };
    },
    async readBlob(blobId) {
      const blob = await blobTransfer.open(blobId);
      if (!blob) throw new Error(`blob ${blobId} not found`);
      return buffer(blob.stream);
    },
  };
}
