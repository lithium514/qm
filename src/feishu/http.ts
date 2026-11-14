import { createHash, timingSafeEqual } from "node:crypto";
import { AESCipher, generateChallenge } from "@larksuiteoapi/node-sdk";
import { PayloadTooLargeError, readBodyBytes } from "../../plugins/chassis/src/http.ts";
import { sendJson } from "../api/http.ts";
import { errMessage } from "../util/errors.ts";
import type { BaseCtx, Route } from "../api/routes/route.ts";
import { isObj } from "../util/objects.ts";
import { parseCardAction, type FeishuCardAction } from "./payloads.ts";
import type { FeishuCardResponse } from "./handler.ts";

const FEISHU_CARD_MAX_BODY_BYTES = 256 * 1024;
export const FEISHU_CARD_TIMESTAMP_WINDOW_MS = 5 * 60_000;

export interface FeishuCardEndpoint {
  verificationToken?: string;
  encryptKey?: string;
  handle(action: FeishuCardAction, body: unknown): Promise<FeishuCardResponse | undefined>;
}

function header(req: BaseCtx["req"], name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function feishuSignature(input: { timestamp: string; nonce: string; encryptKey: string; body: string }): string {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.encryptKey + input.body)
    .digest("hex");
}

interface FeishuSignatureCheck {
  ok: boolean;
  reason?: string;
  scheme?: "sha256-encrypt-key" | "sha1-verification-token";
}

function verifyFeishuSignatureDetailed(input: {
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  encryptKey: string | undefined;
  verificationToken?: string | undefined;
  body: string;
  rawBody?: string;
  now?: number;
}): FeishuSignatureCheck {
  if (!input.encryptKey && !input.verificationToken) return { ok: true };
  if (!input.timestamp || !input.nonce || !input.signature) return { ok: false, reason: "missing signature headers" };
  const timestampNumber = Number(input.timestamp);
  if (Number.isFinite(timestampNumber)) {
    const now = input.now ?? Date.now();
    const timestampMs = timestampNumber > 1e12 ? timestampNumber : timestampNumber * 1000;
    if (Math.abs(now - timestampMs) > FEISHU_CARD_TIMESTAMP_WINDOW_MS) return { ok: false, reason: "stale timestamp" };
  }
  const body = input.rawBody ?? input.body;
  const schemes: Array<{ secret: string; hash: "sha1" | "sha256"; scheme: FeishuSignatureCheck["scheme"] }> = [
    ...(input.encryptKey
      ? [{ secret: input.encryptKey, hash: "sha256" as const, scheme: "sha256-encrypt-key" as const }]
      : []),
    ...(input.verificationToken
      ? [{ secret: input.verificationToken, hash: "sha1" as const, scheme: "sha1-verification-token" as const }]
      : []),
  ];
  for (const { secret, hash, scheme } of schemes) {
    const candidate = createHash(hash)
      .update(input.timestamp + input.nonce + secret + body)
      .digest("hex");
    if (safeEqual(candidate, input.signature)) return { ok: true, scheme };
  }
  return { ok: false, reason: "signature mismatch" };
}

export function verifyFeishuSignature(input: {
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  encryptKey: string | undefined;
  verificationToken?: string | undefined;
  body: string;
  rawBody?: string;
  now?: number;
}): boolean {
  return verifyFeishuSignatureDetailed(input).ok;
}

function decodeBody(parsed: unknown, encryptKey: string | undefined): unknown {
  if (!isObj(parsed) || typeof parsed.encrypt !== "string") return parsed;
  if (!encryptKey) throw new Error("encrypted Feishu card callback without an encrypt key");
  const decrypted: unknown = JSON.parse(new AESCipher(encryptKey).decrypt(parsed.encrypt));
  return decrypted;
}

async function handleFeishuCard(ctx: BaseCtx): Promise<void> {
  console.log(`[feishu] card callback ${ctx.method} ${ctx.pathname}`);
  const endpoint = ctx.deps.feishuCard;
  if (!endpoint) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return;
  }
  if (!endpoint.encryptKey && !endpoint.verificationToken) {
    sendJson(ctx.res, 503, { error: "feishu_card_not_configured" });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBodyBytes(ctx.req, FEISHU_CARD_MAX_BODY_BYTES);
  } catch (error) {
    console.error(`[feishu] card callback body failed: ${errMessage(error)}`);
    if (error instanceof PayloadTooLargeError) sendJson(ctx.res, 413, { error: "payload_too_large" });
    else sendJson(ctx.res, 400, { error: "bad_request" });
    return;
  }
  const bodyText = raw.toString("utf8");
  let outer: unknown;
  let body: unknown;
  try {
    outer = JSON.parse(bodyText);
    body = decodeBody(outer, endpoint.encryptKey);
  } catch (error) {
    console.error(`[feishu] card callback decode failed: ${errMessage(error)}`);
    sendJson(ctx.res, 400, { error: "bad_request" });
    return;
  }
  let challenge;
  try {
    challenge = generateChallenge(outer as Record<string, unknown>, {
      encryptKey: endpoint.encryptKey ?? "",
      ...(endpoint.verificationToken ? { verificationToken: endpoint.verificationToken } : {}),
    });
  } catch (error) {
    console.error(`[feishu] card callback challenge rejected: ${errMessage(error)}`);
    sendJson(ctx.res, 401, { error: "invalid_token" });
    return;
  }
  if (challenge.isChallenge) {
    console.log("[feishu] card callback challenge");
    sendJson(ctx.res, 200, challenge.challenge);
    return;
  }
  const timestamp = header(ctx.req, "x-lark-request-timestamp");
  const nonce = header(ctx.req, "x-lark-request-nonce");
  const signature = header(ctx.req, "x-lark-signature");
  const verification = verifyFeishuSignatureDetailed({
    timestamp,
    nonce,
    signature,
    encryptKey: endpoint.encryptKey,
    verificationToken: endpoint.verificationToken,
    body: JSON.stringify(outer),
    rawBody: bodyText,
  });
  if (!verification.ok) {
    const encrypted = isObj(outer) && typeof outer.encrypt === "string";
    console.error(
      `[feishu] card callback rejected: ${verification.reason} (encrypted=${encrypted} timestamp=${Boolean(timestamp)} nonce=${Boolean(nonce)} signature=${Boolean(signature)})`,
    );
    sendJson(ctx.res, 401, { error: "invalid_signature" });
    return;
  }
  console.log(`[feishu] card callback signature ok (${verification.scheme ?? "none"})`);
  const action = parseCardAction(body);
  if (!action) {
    console.error("[feishu] card callback rejected: malformed action");
    sendJson(ctx.res, 400, { error: "bad_request" });
    return;
  }
  console.log(
    `[feishu] card action ${action.actionName ?? action.actionTag ?? "?"} message=${action.messageId} operator=${action.operatorOpenId}`,
  );
  const result = await endpoint.handle(action, body);
  console.log(`[feishu] card action result ${result ? "responded" : "empty"}`);
  if (!result) {
    sendJson(ctx.res, 200, {});
    return;
  }
  sendJson(ctx.res, 200, {
    ...(result.toast ? { toast: result.toast } : {}),
    ...(result.card ? { card: { type: "raw", data: result.card } } : {}),
  });
}

export const feishuCardRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/feishu/card", auth: "public", handle: handleFeishuCard },
];
