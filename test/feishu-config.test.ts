import { test } from "node:test";
import assert from "node:assert/strict";
import { feishuPluginConfigFromEnv, parseFeishuDomain } from "../src/feishu/config.ts";

test("feishuPluginConfigFromEnv requires app id and secret", () => {
  assert.equal(feishuPluginConfigFromEnv({}), null);
  assert.equal(feishuPluginConfigFromEnv({ FEISHU_APP_ID: "cli_x" }), null);
  assert.equal(feishuPluginConfigFromEnv({ FEISHU_APP_SECRET: "secret" }), null);
  assert.deepEqual(feishuPluginConfigFromEnv({ FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "secret" }), {
    appId: "cli_x",
    appSecret: "secret",
    domain: "feishu",
  });
});

test("feishuPluginConfigFromEnv parses domain, verification, and logging", () => {
  const config = feishuPluginConfigFromEnv({
    FEISHU_APP_ID: "cli_x",
    FEISHU_APP_SECRET: "secret",
    FEISHU_DOMAIN: "LARK",
    FEISHU_VERIFICATION_TOKEN: "verify",
    FEISHU_ENCRYPT_KEY: "encrypt",
    FEISHU_LOG_LEVEL: "debug",
    FEISHU_BOT_NAME: "qm",
  });
  assert.equal(config?.domain, "lark");
  assert.equal(config?.verificationToken, "verify");
  assert.equal(config?.encryptKey, "encrypt");
  assert.equal(config?.logLevel, "debug");
  assert.equal(config?.botName, "qm");
});

test("feishuPluginConfigFromEnv honors the dev disable switch", () => {
  assert.equal(
    feishuPluginConfigFromEnv({
      DEV_INSTANCE_NO_FEISHU: "1",
      FEISHU_APP_ID: "cli_x",
      FEISHU_APP_SECRET: "secret",
    }),
    null,
  );
});

test("parseFeishuDomain defaults to Feishu", () => {
  assert.equal(parseFeishuDomain(undefined), "feishu");
  assert.equal(parseFeishuDomain("lark"), "lark");
  assert.equal(parseFeishuDomain("other"), "feishu");
});
