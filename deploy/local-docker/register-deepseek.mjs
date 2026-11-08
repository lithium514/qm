import { readFileSync } from "node:fs";
import { signedRequestHeaders, withSourceAuthNonce } from "../../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../plugins/chassis/src/portal-identity.ts";

function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    )
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const env = readEnv(new URL("../../.env", import.meta.url).pathname);
const apiKey = env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is empty in .env");
  process.exit(1);
}
const body = JSON.stringify({
  name: "DeepSeek",
  protocol: "openai",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey,
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, maxTokens: 8192 },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128000, maxTokens: 8192, reasoning: true },
  ],
});
const path = withSourceAuthNonce("/v1/admin/custom-providers/deepseek", env.CORE_SIGNING_SECRET);
const response = await fetch(`http://127.0.0.1:18080${path}`, {
  method: "PUT",
  headers: {
    ...signedRequestHeaders(env.CORE_SIGNING_SECRET, "PUT", path, body),
    "content-type": "application/json",
    "x-admin-actor": env.ADMIN_EMAIL,
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
      { p: env.ADMIN_EMAIL, exp: Date.now() + 300000 },
      env.PORTAL_IDENTITY_SECRET,
    ),
  },
  body,
});
console.log(response.status, await response.text());
