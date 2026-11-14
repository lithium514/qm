import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "../src/api/app.ts";
import type { BlobTransferStore } from "../src/persistence/blob-transfer.ts";
import type { IdentityService } from "../src/identity/identity-service.ts";
import { createFeishuCore } from "../src/feishu/core.ts";

test("feishu core resolves a Feishu sender through identity links", () => {
  const identity = {
    resolve(actor: { externalId: string }) {
      return { id: actor.externalId === "ou_1" ? "alice@example.com" : actor.externalId, type: "internal" as const };
    },
  } as unknown as IdentityService;
  const core = createFeishuCore({} as App, {} as BlobTransferStore, undefined, undefined, identity);
  assert.equal(core.resolvePrincipal?.("ou_1"), "alice@example.com");
  assert.equal(core.resolvePrincipal?.("ou_2"), "ou_2");
});
