import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

interface Permissions {
  scopes?: { tenant?: string[]; user?: string[] };
}

const permissions = JSON.parse(
  readFileSync(new URL("../deploy/feishu-permissions.json", import.meta.url), "utf8"),
) as Permissions;

test("feishu permissions file uses the console batch import shape", () => {
  assert.ok(Array.isArray(permissions.scopes?.tenant));
  assert.ok(Array.isArray(permissions.scopes?.user));
  assert.equal(new Set(permissions.scopes!.tenant).size, permissions.scopes!.tenant!.length);
});

test("feishu user permissions cover user-token reads, sends, and refresh", () => {
  for (const scope of [
    "im:message.send_as_user",
    "im:message",
    "im:message.p2p_msg:get_as_user",
    "im:message.group_msg:get_as_user",
    "im:chat:readonly",
    "im:chat.members:read",
    "im:resource",
    "offline_access",
  ]) {
    assert.ok(permissions.scopes!.user!.includes(scope), `missing ${scope}`);
  }
  assert.equal(new Set(permissions.scopes!.user).size, permissions.scopes!.user!.length);
});

test("feishu permissions cover the bot, chat, directory, and file paths", () => {
  for (const scope of [
    "im:message:send_as_bot",
    "im:message",
    "im:chat.members:read",
    "im:resource",
    "contact:user.base:readonly",
    "application:application",
    "application:application:patch",
    "application:application:self_manage",
    "cardkit:card:write",
  ]) {
    assert.ok(permissions.scopes!.tenant!.includes(scope), `missing ${scope}`);
  }
});
