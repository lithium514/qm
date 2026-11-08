import * as lark from "@larksuiteoapi/node-sdk";

const appId = process.env.FEISHU_APP_ID?.trim();
const appSecret = process.env.FEISHU_APP_SECRET?.trim();
if (!appId || !appSecret) {
  console.error("Set FEISHU_APP_ID and FEISHU_APP_SECRET (or run npm run feishu-login).");
  process.exit(1);
}

const id = appId;
const secret = appSecret;
const domain = process.env.FEISHU_DOMAIN?.trim().toLowerCase() === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

interface BotInfo {
  bot?: { app_name?: string; open_id?: string; avatar_url?: string };
}

async function main(): Promise<void> {
  const client = new lark.Client({ appId: id, appSecret: secret, appType: lark.AppType.SelfBuild, domain });
  const bot = (await client.request({ method: "GET", url: "/open-apis/bot/v3/info" })) as BotInfo;
  console.log(`bot: ${bot.bot?.app_name ?? "(unnamed)"} ${bot.bot?.open_id ?? ""}`);

  const chats = await client.im.v1.chat.list({ params: { page_size: 20, sort_type: "ByActiveTimeDesc" } });
  const items = chats.data?.items ?? [];
  if (!items.length) {
    console.log("chats: none — DM the bot or add it to a group, then rerun.");
  } else {
    for (const chat of items) {
      console.log(`chat: ${chat.chat_id} [${chat.chat_mode ?? "?"}] ${chat.name ?? "(no name)"}`);
    }
  }

  const channel = lark.createLarkChannel({
    appId: id,
    appSecret: secret,
    domain,
    transport: "websocket",
    includeRawEvent: true,
  });
  try {
    await channel.connect();
    console.log(
      `websocket: connected as ${channel.botIdentity?.name ?? "(unnamed)"} ${channel.botIdentity?.openId ?? ""}`,
    );
    const testChatId = process.env.FEISHU_TEST_CHAT_ID?.trim();
    if (testChatId) {
      await channel.send(testChatId, { markdown: "QM Feishu doctor: connected." });
      console.log(`sent: ${testChatId}`);
    }
  } finally {
    await channel.disconnect();
  }
  console.log("ok");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes("21001")) {
    console.error(
      "21001 is Feishu's platform-policy denial. Accounts created through Doubao (or personal tenants) cannot call OpenAPI. Use a company Feishu tenant, or register a new Feishu account with a phone number and create the app there.",
    );
  }
  if (message.includes("232034") || message.includes("unavailable or inactivate")) {
    console.error(
      "232034 means the app is not activated/available in this tenant. Publish a version in 版本管理与发布, have a tenant admin approve/enable it, and set its 可用范围; then rerun.",
    );
  }
  process.exitCode = 1;
});
