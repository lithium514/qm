import { AppType, Client, Domain, LoggerLevel, createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain, FeishuPluginConfig } from "./config.ts";

const LOGGER_LEVELS: Record<string, LoggerLevel> = {
  fatal: LoggerLevel.fatal,
  error: LoggerLevel.error,
  warn: LoggerLevel.warn,
  info: LoggerLevel.info,
  debug: LoggerLevel.debug,
  trace: LoggerLevel.trace,
};

const FEISHU_DEDUP_TTL_MS = 10 * 60_000;
const FEISHU_STALE_MESSAGE_WINDOW_MS = 10 * 60_000;

function resolveFeishuDomain(domain: FeishuDomain | undefined): Domain {
  return domain === "lark" ? Domain.Lark : Domain.Feishu;
}

function resolveFeishuLoggerLevel(value: string | undefined): LoggerLevel {
  const level = value?.trim().toLowerCase();
  return level && level in LOGGER_LEVELS ? LOGGER_LEVELS[level]! : LoggerLevel.info;
}

export function createFeishuChannel(config: FeishuPluginConfig): LarkChannel {
  return createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveFeishuDomain(config.domain),
    transport: "websocket",
    includeRawEvent: true,
    loggerLevel: resolveFeishuLoggerLevel(config.logLevel),
    handshakeTimeoutMs: 15_000,
    safety: {
      dedup: { ttl: FEISHU_DEDUP_TTL_MS, maxEntries: 10_000 },
      staleMessageWindowMs: FEISHU_STALE_MESSAGE_WINDOW_MS,
      chatQueue: { enabled: true },
    },
    policy: {
      dmMode: "open",
      requireMention: false,
      respondToMentionAll: false,
    },
    outbound: {
      textChunkLimit: 4_000,
      markdownConverter: "builtin",
    },
  });
}

export function createFeishuClient(config: FeishuPluginConfig): Client {
  return new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: AppType.SelfBuild,
    domain: resolveFeishuDomain(config.domain),
  });
}
