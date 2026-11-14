import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BaseCtx } from "../src/api/routes/route.ts";
import {
  FEISHU_CARD_TIMESTAMP_WINDOW_MS,
  feishuCardRawRoutes,
  feishuSignature,
  verifyFeishuSignature,
  type FeishuCardEndpoint,
} from "../src/feishu/http.ts";
import type { FeishuCardAction } from "../src/feishu/payloads.ts";

const route = feishuCardRawRoutes.find((candidate) => "path" in candidate && candidate.path === "/feishu/card")!;

function context(
  body: unknown,
  options: { endpoint?: FeishuCardEndpoint; headers?: Record<string, string> } = {},
): { ctx: BaseCtx; status: () => number; json: () => unknown } {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
  req.headers = options.headers ?? {};
  const chunks: string[] = [];
  let status = 0;
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;
  const res = {
    req,
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    get destroyed() {
      return destroyed;
    },
    getHeader() {
      return undefined;
    },
    writeHead(next: number) {
      status = next;
      headersSent = true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk).toString("utf8"));
      writableEnded = true;
    },
    destroy() {
      destroyed = true;
    },
  } as unknown as ServerResponse;
  const ctx = {
    req,
    res,
    deps: options.endpoint ? { feishuCard: options.endpoint } : {},
  } as unknown as BaseCtx;
  return {
    ctx,
    status: () => status,
    json: () => (chunks.length ? JSON.parse(chunks.join("")) : undefined),
  };
}

test("feishu signature verification accepts a fresh signed body", () => {
  const now = 1_723_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const nonce = "n1";
  const encryptKey = "ek";
  const body = '{"hello":"world"}';
  const signature = feishuSignature({ timestamp, nonce, encryptKey, body });
  assert.equal(verifyFeishuSignature({ timestamp, nonce, signature, encryptKey, body, now }), true);
  assert.equal(verifyFeishuSignature({ timestamp, nonce, signature, encryptKey, body: "{}", now }), false);
  assert.equal(
    verifyFeishuSignature({
      timestamp,
      nonce,
      signature,
      encryptKey,
      body,
      now: now + FEISHU_CARD_TIMESTAMP_WINDOW_MS + 1,
    }),
    false,
  );
  assert.equal(verifyFeishuSignature({ timestamp, nonce, signature, encryptKey: undefined, body, now }), true);
});

test("feishu card route is absent without an endpoint", async () => {
  const { ctx, status, json } = context({});
  await route.handle(ctx);
  assert.equal(status(), 404);
  assert.deepEqual(json(), { error: "not_found" });
});

test("feishu card route answers the verification challenge", async () => {
  let called = false;
  const endpoint: FeishuCardEndpoint = {
    verificationToken: "verify",
    async handle() {
      called = true;
      return undefined;
    },
  };
  const { ctx, status, json } = context(
    { type: "url_verification", challenge: "challenge-value", token: "verify" },
    { endpoint },
  );
  await route.handle(ctx);
  assert.equal(status(), 200);
  assert.deepEqual(json(), { challenge: "challenge-value" });
  assert.equal(called, false);
});

test("feishu card route rejects the wrong verification token", async () => {
  const endpoint: FeishuCardEndpoint = {
    verificationToken: "verify",
    async handle() {
      return undefined;
    },
  };
  const { ctx, status } = context({ type: "url_verification", challenge: "c", token: "wrong" }, { endpoint });
  await route.handle(ctx);
  assert.equal(status(), 401);
});

test("feishu card route verifies the signature and dispatches the action", async () => {
  const actions: FeishuCardAction[] = [];
  const endpoint: FeishuCardEndpoint = {
    encryptKey: "encrypt-key",
    async handle(action) {
      actions.push(action);
      return { toast: { type: "info", content: "approved" } };
    },
  };
  const body = {
    schema: "2.0",
    header: { event_id: "evt_1", event_type: "card.action.trigger" },
    event: {
      operator: { open_id: "ou_1" },
      action: { tag: "button", value: { qm: "approval", id: "a_1", value: "allow_once" } },
      context: { open_message_id: "om_1", open_chat_id: "oc_1" },
    },
  };
  const text = JSON.stringify(body, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "n1";
  const signature = feishuSignature({
    timestamp,
    nonce,
    encryptKey: "encrypt-key",
    body: text,
  });
  const { ctx, status, json } = context(text, {
    endpoint,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
  });
  await route.handle(ctx);
  assert.equal(status(), 200);
  assert.deepEqual(json(), { toast: { type: "info", content: "approved" } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.operatorOpenId, "ou_1");
  assert.equal(actions[0]!.messageId, "om_1");
  assert.deepEqual(actions[0]!.value, { qm: "approval", id: "a_1", value: "allow_once" });
});

test("feishu card route rejects a bad signature", async () => {
  const endpoint: FeishuCardEndpoint = {
    encryptKey: "encrypt-key",
    async handle() {
      return undefined;
    },
  };
  const { ctx, status } = context(
    {
      schema: "2.0",
      header: { event_id: "evt_1" },
      event: { operator: { open_id: "ou_1" }, action: { tag: "button", value: {} } },
    },
    {
      endpoint,
      headers: {
        "x-lark-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-lark-request-nonce": "n1",
        "x-lark-signature": "bad",
      },
    },
  );
  await route.handle(ctx);
  assert.equal(status(), 401);
});

test("feishu card route rejects a malformed action", async () => {
  const endpoint: FeishuCardEndpoint = {
    verificationToken: "verify",
    async handle() {
      return undefined;
    },
  };
  const body = { token: "verify", event: {} };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "n-malformed";
  const signature = createHash("sha1")
    .update(timestamp + nonce + "verify" + JSON.stringify(body))
    .digest("hex");
  const { ctx, status } = context(body, {
    endpoint,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
  });
  await route.handle(ctx);
  assert.equal(status(), 400);
});

function encryptCardBody(encryptKey: string, value: unknown): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final()]).toString("base64");
}

test("feishu card route decrypts an encrypted callback and dispatches it", async () => {
  const encryptKey = "12345678901234567890123456789012";
  const actions: FeishuCardAction[] = [];
  const endpoint: FeishuCardEndpoint = {
    encryptKey,
    async handle(action) {
      actions.push(action);
      return { toast: { type: "info", content: "decrypted" } };
    },
  };
  const event = {
    schema: "2.0",
    header: { event_id: "evt_enc", event_type: "card.action.trigger" },
    event: {
      operator: { open_id: "ou_enc" },
      action: { tag: "button", value: { qm: "approval", id: "enc_1", value: "once" } },
      context: { open_message_id: "om_enc", open_chat_id: "oc_enc" },
    },
  };
  const outer = { encrypt: encryptCardBody(encryptKey, event) };
  const text = JSON.stringify(outer, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "n-enc";
  const signature = feishuSignature({
    timestamp,
    nonce,
    encryptKey,
    body: text,
  });
  const { ctx, status, json } = context(text, {
    endpoint,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
  });
  await route.handle(ctx);
  assert.equal(status(), 200);
  assert.deepEqual(json(), { toast: { type: "info", content: "decrypted" } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.operatorOpenId, "ou_enc");
  assert.equal(actions[0]!.messageId, "om_enc");
});

test("feishu signature verification also accepts the verification-token SHA-1 scheme", () => {
  const now = 1_723_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const nonce = "n-token";
  const verificationToken = "verify-token";
  const body = JSON.stringify({ schema: "2.0", header: { token: verificationToken } });
  const signature = createHash("sha1")
    .update(timestamp + nonce + verificationToken + body)
    .digest("hex");
  assert.equal(
    verifyFeishuSignature({
      timestamp,
      nonce,
      signature,
      encryptKey: undefined,
      verificationToken,
      body,
      now,
    }),
    true,
  );
  assert.equal(
    verifyFeishuSignature({
      timestamp,
      nonce,
      signature,
      encryptKey: undefined,
      verificationToken,
      body: "{}",
      now,
    }),
    false,
  );
});
