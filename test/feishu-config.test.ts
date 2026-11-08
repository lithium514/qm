import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feishuAccountConfigsFromEnv,
  feishuPluginConfigFromEnv,
  parseFeishuDomain,
  parseFeishuHistoryLimit,
} from "../src/feishu/config.ts";

test("feishuPluginConfigFromEnv requires app id and secret", () => {
  assert.equal(feishuPluginConfigFromEnv({}), null);
  assert.equal(feishuPluginConfigFromEnv({ FEISHU_APP_ID: "cli_x" }), null);
  assert.equal(feishuPluginConfigFromEnv({ FEISHU_APP_SECRET: "secret" }), null);
  assert.deepEqual(
    feishuPluginConfigFromEnv({
      FEISHU_APP_ID: "cli_x",
      FEISHU_APP_SECRET: "secret",
    }),
    { appId: "cli_x", appSecret: "secret", domain: "feishu" },
  );
});

test("feishuPluginConfigFromEnv parses domain, allowlist, deny message, and limits", () => {
  const config = feishuPluginConfigFromEnv({
    FEISHU_APP_ID: "cli_x",
    FEISHU_APP_SECRET: "secret",
    FEISHU_DOMAIN: "LARK",
    FEISHU_VERIFICATION_TOKEN: "verify",
    FEISHU_ENCRYPT_KEY: "encrypt",
    FEISHU_ALLOW_FROM: "Alice@Example.com, @example.org",
    FEISHU_DENY_MESSAGE: "not allowed",
    FEISHU_HISTORY_LIMIT: "20",
    FEISHU_LOG_LEVEL: "debug",
    FEISHU_BOT_NAME: "qm",
  });
  assert.equal(config?.domain, "lark");
  assert.equal(config?.verificationToken, "verify");
  assert.equal(config?.encryptKey, "encrypt");
  assert.deepEqual(config?.allowFrom, ["alice@example.com", "example.org"]);
  assert.equal(config?.denyMessage, "not allowed");
  assert.equal(config?.historyLimit, 20);
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

test("parseFeishuHistoryLimit bounds the page size", () => {
  assert.equal(parseFeishuHistoryLimit(undefined), undefined);
  assert.equal(parseFeishuHistoryLimit("1"), 1);
  assert.equal(parseFeishuHistoryLimit("50"), 50);
  assert.throws(() => parseFeishuHistoryLimit("0"), /1 to 50/);
  assert.throws(() => parseFeishuHistoryLimit("51"), /1 to 50/);
  assert.throws(() => parseFeishuHistoryLimit("1.5"), /1 to 50/);
});

test("parseFeishuDomain defaults to Feishu", () => {
  assert.equal(parseFeishuDomain(undefined), "feishu");
  assert.equal(parseFeishuDomain("lark"), "lark");
  assert.equal(parseFeishuDomain("other"), "feishu");
});

test("feishuAccountConfigsFromEnv parses account arrays and rejects duplicates", () => {
  const accounts = feishuAccountConfigsFromEnv({
    FEISHU_ACCOUNTS: JSON.stringify([
      { id: "acme", appId: "cli_a", appSecret: "a", domain: "lark", allowFrom: ["a@b.co"] },
      { id: "beta", appId: "cli_b", appSecret: "b", historyLimit: 10 },
    ]),
  });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.accountId, "acme");
  assert.equal(accounts[0]?.domain, "lark");
  assert.deepEqual(accounts[0]?.allowFrom, ["a@b.co"]);
  assert.equal(accounts[1]?.historyLimit, 10);
  assert.throws(
    () =>
      feishuAccountConfigsFromEnv({
        FEISHU_ACCOUNTS: JSON.stringify([
          { id: "dup", appId: "cli_a", appSecret: "a" },
          { id: "dup", appId: "cli_b", appSecret: "b" },
        ]),
      }),
    /duplicate id/,
  );
  assert.throws(
    () => feishuAccountConfigsFromEnv({ FEISHU_ACCOUNTS: JSON.stringify([{ id: "x" }]) }),
    /needs appId and appSecret/,
  );
});
