import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("directory upsert merges members and replaces one channel roster", async () => {
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  await store.upsertMembers?.([
    { principalId: "ou_alice", displayName: "Alice", type: "internal" },
    { principalId: "ou_bob", displayName: "Bob", type: "internal" },
    { principalId: "ou_ext", displayName: "Partner", type: "guest" },
  ]);
  const members = await store.list();
  assert.deepEqual(members.map((member) => [member.principalId, member.displayName, member.type]).sort(), [
    ["ou_alice", "Alice", "internal"],
    ["ou_bob", "Bob", "internal"],
    ["ou_ext", "Partner", "guest"],
  ]);

  await store.upsertChannels?.(
    [
      { channelId: "oc_1", name: "team", isPrivate: false },
      { channelId: "oc_2", name: "partner", isExternal: true },
    ],
    [
      { channelId: "oc_1", principalId: "ou_alice" },
      { channelId: "oc_1", principalId: "ou_bob" },
      { channelId: "oc_2", principalId: "ou_ext" },
    ],
  );
  assert.deepEqual(
    (await store.listChannels()).map((channel) => [channel.channelId, channel.name, !!channel.isExternal]).sort(),
    [
      ["oc_1", "team", false],
      ["oc_2", "partner", true],
    ],
  );
  assert.deepEqual(await store.channelMemberIds("oc_1"), ["ou_alice", "ou_bob"]);

  await store.upsertChannels?.(
    [{ channelId: "oc_1", name: "team", isPrivate: false }],
    [{ channelId: "oc_1", principalId: "ou_alice" }],
  );
  assert.deepEqual(await store.channelMemberIds("oc_1"), ["ou_alice"]);
  assert.deepEqual(await store.channelMemberIds("oc_2"), ["ou_ext"]);
});
