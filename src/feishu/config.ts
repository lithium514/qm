import { normalizeAllowFrom, parseAllowFrom } from "../util/allow-from.ts";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuPluginConfig {
  appId: string;
  appSecret: string;
  accountId?: string;
  domain?: FeishuDomain;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
  denyMessage?: string;
  historyLimit?: number;
  logLevel?: string;
  botName?: string;
}

export const FEISHU_HISTORY_LIMIT_MAX = 50;

export function parseFeishuHistoryLimit(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > FEISHU_HISTORY_LIMIT_MAX)
    throw new Error(`FEISHU_HISTORY_LIMIT must be an integer from 1 to ${FEISHU_HISTORY_LIMIT_MAX}`);
  return limit;
}

export function parseFeishuDomain(value: string | undefined): FeishuDomain {
  return value?.trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

export function feishuPluginConfigFromEnv(env: Record<string, string | undefined>): FeishuPluginConfig | null {
  if (env.DEV_INSTANCE_NO_FEISHU === "1") return null;
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  const allowFrom = parseAllowFrom(env.FEISHU_ALLOW_FROM);
  const denyMessage = env.FEISHU_DENY_MESSAGE?.trim();
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
  const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
  const logLevel = env.FEISHU_LOG_LEVEL?.trim();
  const botName = env.FEISHU_BOT_NAME?.trim();
  const historyLimit = parseFeishuHistoryLimit(env.FEISHU_HISTORY_LIMIT);
  return {
    appId,
    appSecret,
    domain: parseFeishuDomain(env.FEISHU_DOMAIN),
    ...(verificationToken ? { verificationToken } : {}),
    ...(encryptKey ? { encryptKey } : {}),
    ...(allowFrom.length ? { allowFrom } : {}),
    ...(denyMessage ? { denyMessage } : {}),
    ...(historyLimit !== undefined ? { historyLimit } : {}),
    ...(logLevel ? { logLevel } : {}),
    ...(botName ? { botName } : {}),
  };
}

export function feishuAccountConfigsFromEnv(env: Record<string, string | undefined>): FeishuPluginConfig[] {
  if (env.DEV_INSTANCE_NO_FEISHU === "1") return [];
  const raw = env.FEISHU_ACCOUNTS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`FEISHU_ACCOUNTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed)) throw new Error("FEISHU_ACCOUNTS must be a JSON array of account objects");
  const out: FeishuPluginConfig[] = [];
  const seenIds = new Set<string>();
  for (const [i, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) throw new Error(`FEISHU_ACCOUNTS[${i}] must be an object`);
    const a = entry as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const id = str(a.id);
    if (!id) throw new Error(`FEISHU_ACCOUNTS[${i}] needs an "id"`);
    if (seenIds.has(id)) throw new Error(`FEISHU_ACCOUNTS has duplicate id "${id}"`);
    seenIds.add(id);
    const accountEnv: Record<string, string | undefined> = {
      FEISHU_APP_ID: str(a.appId),
      FEISHU_APP_SECRET: str(a.appSecret),
      FEISHU_DOMAIN: str(a.domain),
      FEISHU_VERIFICATION_TOKEN: str(a.verificationToken) ?? env.FEISHU_VERIFICATION_TOKEN,
      FEISHU_ENCRYPT_KEY: str(a.encryptKey) ?? env.FEISHU_ENCRYPT_KEY,
      FEISHU_ALLOW_FROM: str(a.allowFrom),
      FEISHU_DENY_MESSAGE: str(a.denyMessage),
      FEISHU_HISTORY_LIMIT: a.historyLimit === undefined ? env.FEISHU_HISTORY_LIMIT : String(a.historyLimit),
      FEISHU_LOG_LEVEL: env.FEISHU_LOG_LEVEL,
      FEISHU_BOT_NAME: str(a.botName) ?? env.FEISHU_BOT_NAME,
    };
    const config = feishuPluginConfigFromEnv(accountEnv);
    if (!config) throw new Error(`FEISHU_ACCOUNTS[${i}] ("${id}") needs appId and appSecret`);
    const allowFrom = Array.isArray(a.allowFrom) ? normalizeAllowFrom(a.allowFrom) : config.allowFrom;
    out.push({
      ...config,
      accountId: id,
      ...(allowFrom?.length ? { allowFrom } : {}),
    });
  }
  return out;
}
