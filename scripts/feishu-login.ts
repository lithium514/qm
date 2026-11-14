import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";
import {
  FEISHU_CALLBACKS,
  FEISHU_EVENTS,
  FEISHU_TENANT_SCOPES,
  FEISHU_USER_SCOPES,
  configureFeishuApp,
  feishuClient,
} from "./lib/feishu-app.ts";

const STATUS_PATH = process.env.FEISHU_LOGIN_STATUS ?? "/tmp/feishu-login.json";
const ENV_PATH = process.env.FEISHU_ENV_FILE ?? ".env";
const APP_NAME = process.env.FEISHU_APP_NAME?.trim() || "QM";

interface LoginStatus {
  state: string;
  url?: string;
  expireIn?: number;
  appId?: string;
  error?: string;
}

function status(value: LoginStatus): void {
  writeFileSync(STATUS_PATH, `${JSON.stringify(value, null, 2)}\n`);
}

function setEnv(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(contents)) return contents.replace(pattern, line);
  return `${contents.replace(/\s*$/, "")}\n${line}\n`;
}

function updateEnvFile(appId: string, appSecret: string, domain: "feishu" | "lark"): void {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  let next = current;
  next = setEnv(next, "FEISHU_APP_ID", appId);
  next = setEnv(next, "FEISHU_APP_SECRET", appSecret);
  next = setEnv(next, "FEISHU_DOMAIN", domain);
  writeFileSync(ENV_PATH, next);
}

async function main(): Promise<void> {
  status({ state: "starting" });
  const result = await lark.registerApp({
    ...(process.env.FEISHU_APP_ID?.trim() ? { appId: process.env.FEISHU_APP_ID.trim() } : {}),
    appPreset: {
      name: APP_NAME,
      desc: `${APP_NAME} runs agent conversations in this workspace.`,
    },
    addons: {
      scopes: { tenant: FEISHU_TENANT_SCOPES, user: FEISHU_USER_SCOPES },
      events: { items: { tenant: FEISHU_EVENTS } },
      callbacks: { items: FEISHU_CALLBACKS },
    },
    onQRCodeReady(info) {
      status({ state: "awaiting_authorization", url: info.url, expireIn: info.expireIn });
      console.log(`FEISHU_LOGIN_URL=${info.url}`);
      console.log(`Open this link or scan it in Feishu (expires in ${info.expireIn}s).`);
    },
    onStatusChange(info) {
      status({ state: info.status, ...(info.interval ? { expireIn: info.interval } : {}) });
    },
  });
  status({ state: "configuring", appId: result.client_id });
  const domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  await configureFeishuApp(
    feishuClient(result.client_id, result.client_secret, domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu),
    result.client_id,
    process.env.FEISHU_CARD_CALLBACK_URL?.trim(),
  );
  updateEnvFile(result.client_id, result.client_secret, domain);
  status({ state: "done", appId: result.client_id });
  console.log(`FEISHU_APP_ID=${result.client_id}`);
  console.log(`Credentials written to ${ENV_PATH}. Start the server, then DM the bot or add it to a group.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status({ state: "failed", error: message });
  console.error(`feishu login failed: ${message}`);
  process.exitCode = 1;
});
