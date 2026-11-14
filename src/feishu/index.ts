import type {
  BotAddedEvent,
  CardActionEvent,
  LarkChannel,
  LarkChannelError,
  NormalizedMessage,
  ReactionEvent,
} from "@larksuiteoapi/node-sdk";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import { createFeishuChannel } from "./channel.ts";
import type { FeishuPluginConfig } from "./config.ts";
import type { FeishuCore } from "./core.ts";
import { createFeishuDeliveryPoller } from "./delivery.ts";
import { createFeishuDirectorySync, type FeishuDirectorySync } from "./directory-sync.ts";
import { createFeishuHistoryReader } from "./history.ts";
import type { FeishuClient } from "./directory.ts";
import { createFeishuCardHandler, createFeishuMessageHandler, type FeishuCardResponse } from "./handler.ts";
import type { FeishuCardAction } from "./payloads.ts";

export { feishuPluginConfigFromEnv } from "./config.ts";
export { createFeishuCore, type FeishuCore } from "./core.ts";

interface FeishuHandlers {
  onMessage(message: NormalizedMessage): void | Promise<void>;
  onCardAction(event: CardActionEvent): void | Promise<void>;
  onReaction(event: ReactionEvent): void | Promise<void>;
  onBotAdded?(event: BotAddedEvent): void | Promise<void>;
  onError?(error: LarkChannelError): void;
}

interface FeishuPlugin {
  channel: LarkChannel;
  stop(): Promise<void>;
}

function guard<T>(context: string, handler: (value: T) => void | Promise<void>): (value: T) => Promise<void> {
  return async (value: T) => {
    try {
      await handler(value);
    } catch (error) {
      reportFailure(context, error);
    }
  };
}

async function startFeishuPlugin(
  config: FeishuPluginConfig,
  handlers: FeishuHandlers,
  channel: LarkChannel = createFeishuChannel(config),
): Promise<FeishuPlugin> {
  channel.on({
    message: guard("feishu: message handler", handlers.onMessage),
    cardAction: guard("feishu: card action handler", handlers.onCardAction),
    reaction: guard("feishu: reaction handler", handlers.onReaction),
    ...(handlers.onBotAdded ? { botAdded: guard("feishu: bot added handler", handlers.onBotAdded) } : {}),
    error: (error) => {
      if (handlers.onError) handlers.onError(error);
      else reportFailure("feishu: channel", error);
    },
  });
  await channel.connect();
  let stopped = false;
  return {
    channel,
    async stop() {
      if (stopped) return;
      stopped = true;
      await channel.disconnect();
    },
  };
}

function cardActionOf(event: CardActionEvent): FeishuCardAction {
  return {
    operatorOpenId: event.operator.openId,
    ...(event.operator.userId ? { operatorUserId: event.operator.userId } : {}),
    messageId: event.messageId,
    chatId: event.chatId,
    actionTag: event.action.tag,
    ...(event.action.name ? { actionName: event.action.name } : {}),
    value: event.action.value,
  };
}

export interface FeishuSurface {
  channel: LarkChannel;
  handleCardAction(action: FeishuCardAction): Promise<FeishuCardResponse | undefined>;
  stop(): Promise<void>;
}

export async function startFeishuSurface(opts: {
  config: FeishuPluginConfig;
  core: FeishuCore;
  cardHandler?: (action: FeishuCardAction) => Promise<FeishuCardResponse | undefined>;
  leaderLease?: LeaderLease;
  pollIntervalMs?: number;
  directory?: DirectoryStore;
}): Promise<FeishuSurface> {
  const channel = createFeishuChannel(opts.config);
  const cardHandler = opts.cardHandler ?? createFeishuCardHandler({ core: opts.core });
  const history = createFeishuHistoryReader({
    core: opts.core,
    channel,
    botOpenId: () => channel.botIdentity?.openId,
  });
  const messageHandler = createFeishuMessageHandler({
    config: opts.config,
    core: opts.core,
    channel,
    readHistory: (request) => history.read(request),
  });
  const directorySync: FeishuDirectorySync | undefined = opts.directory
    ? createFeishuDirectorySync({
        client: channel.rawClient as unknown as FeishuClient,
        directory: opts.directory,
        botOpenId: () => channel.botIdentity?.openId,
        ...(opts.leaderLease ? { leaderLease: opts.leaderLease } : {}),
      })
    : undefined;
  const plugin = await startFeishuPlugin(
    opts.config,
    {
      onMessage: messageHandler,
      onCardAction: (event) => cardHandler(cardActionOf(event)).then(() => undefined),
      onReaction: async () => {},
      onBotAdded: async () => {
        await directorySync?.run().catch(reportFailureAs("feishu directory sync", undefined));
      },
    },
    channel,
  );
  directorySync?.start();
  const poller = createFeishuDeliveryPoller({
    core: opts.core,
    channel,
    ...(opts.leaderLease ? { leaderLease: opts.leaderLease } : {}),
    ...(opts.pollIntervalMs ? { intervalMs: opts.pollIntervalMs } : {}),
  });
  poller.start();
  return {
    channel,
    handleCardAction: cardHandler,
    async stop() {
      await directorySync?.stop();
      await poller.stop();
      await plugin.stop();
    },
  };
}
