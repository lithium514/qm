export interface SurfaceCapabilities {
  id: string;
  label: string;
  toolName: string;
  promptSlack: boolean;
  historyRevisions: boolean;
  replyEngagement: boolean;
  earlyAck: boolean;
  harvestedAck: boolean;
  actingUserId: boolean;
  nativePins: boolean;
  externalSlack: boolean;
  externalAudience: boolean;
  chatRefusalCopy: boolean;
  ambientJudge: boolean;
}

const GENERIC: SurfaceCapabilities = {
  id: "chat",
  label: "chat",
  toolName: "chat",
  promptSlack: false,
  historyRevisions: false,
  replyEngagement: false,
  earlyAck: false,
  harvestedAck: false,
  actingUserId: false,
  nativePins: false,
  externalSlack: false,
  externalAudience: false,
  chatRefusalCopy: false,
  ambientJudge: false,
};

const SLACK: SurfaceCapabilities = {
  ...GENERIC,
  id: "slack",
  label: "Slack",
  toolName: "slack",
  promptSlack: true,
  historyRevisions: true,
  replyEngagement: true,
  earlyAck: true,
  harvestedAck: true,
  actingUserId: true,
  nativePins: true,
  externalSlack: true,
  externalAudience: true,
  chatRefusalCopy: true,
  ambientJudge: true,
};

const FEISHU: SurfaceCapabilities = {
  ...GENERIC,
  id: "feishu",
  label: "Feishu",
  toolName: "feishu",
  chatRefusalCopy: true,
};

const PARTNER_CHAT: SurfaceCapabilities = {
  ...GENERIC,
  id: "partner-chat",
  label: "Partner chat",
  toolName: "partner-chat",
  historyRevisions: true,
  actingUserId: true,
  ambientJudge: true,
};

const WEB: SurfaceCapabilities = {
  ...GENERIC,
  id: "web",
  label: "the web app",
  toolName: "surface",
};

export function surfaceCapabilities(id: string | undefined): SurfaceCapabilities {
  if (id === "slack") return SLACK;
  if (id === "feishu") return FEISHU;
  if (id === "partner-chat") return PARTNER_CHAT;
  if (id === "web") return WEB;
  return id ? { ...GENERIC, id, label: "chat", toolName: id } : GENERIC;
}
