import { readFileSync } from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";

interface FeishuPermissions {
  scopes?: { tenant?: string[]; user?: string[] };
}

const permissions = JSON.parse(
  readFileSync(new URL("../../deploy/feishu-permissions.json", import.meta.url), "utf8"),
) as FeishuPermissions;

export const FEISHU_TENANT_SCOPES = permissions.scopes?.tenant ?? [];
export const FEISHU_USER_SCOPES = permissions.scopes?.user ?? [];

export const FEISHU_EVENTS = [
  "im.message.receive_v1",
  "im.message.reaction.created_v1",
  "im.message.reaction.deleted_v1",
  "im.message.recalled_v1",
  "im.chat.member.bot.added_v1",
  "im.chat.updated_v1",
  "im.chat.member.user.added_v1",
  "im.chat.member.user.deleted_v1",
];

export const FEISHU_CALLBACKS = ["card.action.trigger"];

export function feishuDomain(value: string | undefined): lark.Domain {
  return value?.trim().toLowerCase() === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

export function feishuClient(appId: string, appSecret: string, domain: lark.Domain): lark.Client {
  return new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain });
}

function failureMessage(error: unknown): string {
  const response = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (response?.msg) return `${response.code ?? ""} ${response.msg}`.trim();
  return error instanceof Error ? error.message : String(error);
}

export function feishuOAuthRedirectUrl(cardCallbackUrl?: string): string | undefined {
  const explicit = process.env.FEISHU_OAUTH_REDIRECT_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.PUBLIC_WEB_URL?.trim() || (cardCallbackUrl ? new URL(cardCallbackUrl).origin : "");
  return base ? `${base.replace(/\/$/, "")}/v1/connectors/oauth/feishu/callback` : undefined;
}

export async function configureFeishuApp(client: lark.Client, appId: string, cardCallbackUrl?: string): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      console.log(`${name}: ok`);
    } catch (error) {
      failures.push(`${name}: ${failureMessage(error)}`);
    }
  };
  await step("scopes", () =>
    client.application.v7.applicationConfig.patch({
      path: { app_id: appId },
      data: {
        scope: {
          add_scopes: [
            ...FEISHU_TENANT_SCOPES.map((scope_name) => ({ scope_name, token_type: "tenant" as const })),
            ...FEISHU_USER_SCOPES.map((scope_name) => ({ scope_name, token_type: "user" as const })),
          ],
        },
      },
    }),
  );
  const redirectUrl = feishuOAuthRedirectUrl(cardCallbackUrl);
  if (redirectUrl) {
    await step("oauth redirect", () =>
      client.application.v7.applicationConfig.patch({
        path: { app_id: appId },
        data: {
          security: {
            add: { redirect_urls: [redirectUrl] },
            allow_refresh_token: true,
          },
        },
      }),
    );
  }
  await step("events", () =>
    client.application.v6.application.patch({
      params: { lang: "zh_cn" },
      path: { app_id: appId },
      data: {
        event: { subscription_type: "websocket", subscribed_events: FEISHU_EVENTS },
      },
    }),
  );
  await step("bot", () =>
    client.application.v7.applicationAbility.patch({
      path: { app_id: appId },
      data: {
        bot: {
          enable: true,
          ...(cardCallbackUrl ? { message_card_callback_url: cardCallbackUrl } : {}),
        },
      },
    }),
  );
  if (failures.length) throw new Error(`feishu configure incomplete:\n${failures.join("\n")}`);
}
