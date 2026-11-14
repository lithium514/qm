import { configureFeishuApp, feishuClient, feishuDomain, feishuOAuthRedirectUrl } from "./lib/feishu-app.ts";

const appId = process.env.FEISHU_APP_ID?.trim();
const appSecret = process.env.FEISHU_APP_SECRET?.trim();
if (!appId || !appSecret) {
  console.error("Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env first.");
  process.exit(1);
}

const domain = feishuDomain(process.env.FEISHU_DOMAIN);
const cardCallbackUrl = process.env.FEISHU_CARD_CALLBACK_URL?.trim();
await configureFeishuApp(feishuClient(appId, appSecret, domain), appId, cardCallbackUrl);
const redirectUrl = feishuOAuthRedirectUrl(cardCallbackUrl);
console.log(
  cardCallbackUrl
    ? `configured: long-connection events, webhook card callbacks -> ${cardCallbackUrl}, OAuth redirect -> ${redirectUrl ?? "(none)"}, bot ability`
    : `configured: long-connection events, bot ability, OAuth redirect -> ${redirectUrl ?? "(none)"} (set FEISHU_CARD_CALLBACK_URL for card callbacks)`,
);
