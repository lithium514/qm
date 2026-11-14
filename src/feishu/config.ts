export type FeishuDomain = "feishu" | "lark";

export interface FeishuPluginConfig {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  verificationToken?: string;
  encryptKey?: string;
  logLevel?: string;
  botName?: string;
}

export function parseFeishuDomain(value: string | undefined): FeishuDomain {
  return value?.trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

export function feishuPluginConfigFromEnv(env: Record<string, string | undefined>): FeishuPluginConfig | null {
  if (env.DEV_INSTANCE_NO_FEISHU === "1") return null;
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
  const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
  const logLevel = env.FEISHU_LOG_LEVEL?.trim();
  const botName = env.FEISHU_BOT_NAME?.trim();
  return {
    appId,
    appSecret,
    domain: parseFeishuDomain(env.FEISHU_DOMAIN),
    ...(verificationToken ? { verificationToken } : {}),
    ...(encryptKey ? { encryptKey } : {}),
    ...(logLevel ? { logLevel } : {}),
    ...(botName ? { botName } : {}),
  };
}
