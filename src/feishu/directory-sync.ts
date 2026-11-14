import type {
  ChannelMembership,
  DirectoryChannel,
  DirectoryMember,
  DirectoryStore,
} from "../directory/directory-store.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { listChatMembers, listChats, type FeishuClient } from "./directory.ts";

export interface FeishuDirectorySync {
  start(): void;
  stop(): Promise<void>;
  run(): Promise<void>;
}

export function createFeishuDirectorySync(opts: {
  client: FeishuClient;
  directory: DirectoryStore;
  botOpenId?: string | (() => string | undefined);
  intervalMs?: number;
  leaderLease?: LeaderLease;
}): FeishuDirectorySync {
  const run = async (): Promise<void> => {
    const upsertMembers = opts.directory.upsertMembers?.bind(opts.directory);
    const upsertChannels = opts.directory.upsertChannels?.bind(opts.directory);
    if (!upsertMembers || !upsertChannels) return;
    const botOpenId = typeof opts.botOpenId === "function" ? opts.botOpenId() : opts.botOpenId;
    const chats = await listChats(opts.client);
    const ownTenantKey = chats.find((chat) => !chat.external && chat.tenantKey)?.tenantKey;
    const members = new Map<string, DirectoryMember>();
    const channels: DirectoryChannel[] = [];
    const memberships: ChannelMembership[] = [];
    for (const chat of chats) {
      const chatMembers = await listChatMembers(opts.client, chat.chatId);
      const external = chat.external === true;
      for (const member of chatMembers) {
        if (botOpenId && member.openId === botOpenId) continue;
        const guest = external || (!!ownTenantKey && !!member.tenantKey && member.tenantKey !== ownTenantKey);
        members.set(member.openId, {
          principalId: member.openId,
          displayName: member.name ?? member.openId,
          type: guest ? "guest" : "internal",
        });
        memberships.push({ channelId: chat.chatId, principalId: member.openId });
      }
      channels.push({
        channelId: chat.chatId,
        name: chat.name ?? chat.chatId,
        isPrivate: chat.chatType === "private" || chat.chatMode === "p2p",
        ...(external ? { isExternal: true } : {}),
      });
    }
    await upsertMembers([...members.values()]);
    await upsertChannels(channels, memberships);
  };
  let sweeper: Sweeper | undefined;
  return {
    run,
    start() {
      const pass = () => (opts.leaderLease ? opts.leaderLease.hold("feishu:directory-sync", () => run()) : run());
      sweeper ??= createSweeper(pass, opts.intervalMs ?? 5 * 60_000, {
        label: "feishu directory sync",
        immediate: true,
      });
      sweeper.start();
    },
    async stop() {
      await sweeper?.stop();
      sweeper = undefined;
    },
  };
}
