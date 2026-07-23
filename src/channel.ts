/** Plivo SMS channel plugin: config resolution, DM security, pairing, and outbound send. */

import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createHybridChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { PlivoClient } from "./client.js";
import { normalizeAllowFrom, normalizePhoneNumber } from "./phone.js";
import type { PlivoSmsAccountConfig, PlivoSmsConfig, ResolvedAccount } from "./types.js";

const CHANNEL_ID = "plivo-sms";

function plivoSection(cfg: OpenClawConfig) {
  return (cfg as PlivoSmsConfig).channels?.[CHANNEL_ID];
}

export function listPlivoSmsAccountIds(cfg: OpenClawConfig): string[] {
  return plivoSection(cfg)?.authId ? ["default"] : [];
}

function defaultPlivoSmsAccountId(): string {
  return "default";
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  if (accountId && accountId !== "default") {
    throw new Error(
      `plivo-sms: account "${accountId}" not found. This channel supports a single account (v0.1.0).`,
    );
  }
  const section = plivoSection(cfg);
  if (!section?.authId) throw new Error("plivo-sms: authId is required");
  if (!section?.authToken) throw new Error("plivo-sms: authToken is required");
  return {
    accountId: accountId ?? null,
    authId: section.authId,
    authToken: section.authToken,
    fromNumber: section.fromNumber,
    publicWebhookUrl: section.publicWebhookUrl,
    webhookPath: section.webhookPath,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
  };
}

function buildOutboundParams(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveAccount(cfg, accountId);
  if (!account.fromNumber) {
    throw new Error("plivo-sms: fromNumber is required for outbound");
  }
  const client = new PlivoClient(account.authId, account.authToken);
  return { account, client };
}

/**
 * Shared allowlist predicate for both the inbound sender gate and the outbound
 * guard, so one config governs both directions. In allowlist mode (default) an
 * empty list denies every number (fail closed), a populated list without "*"
 * must contain the number, and either the "open" policy or a "*" entry permits
 * any number. Use dmSecurity "open" or allowFrom ["*"] to allow all senders.
 */
export function isPhoneAllowed(account: ResolvedAccount, phone: string): boolean {
  const policy = account.dmPolicy ?? "allowlist";
  if (policy !== "allowlist") return true;
  const list = account.allowFrom ?? [];
  if (list.length === 0) return false;
  if (list.some((entry) => normalizeAllowFrom(entry) === "*")) return true;
  const target = normalizePhoneNumber(phone);
  return list.some((entry) => normalizePhoneNumber(entry) === target);
}

/**
 * Enforce the allowlist on the outbound path so an allowlisted config can never
 * leak messages to unknown destinations.
 */
export function assertOutboundAllowed(account: ResolvedAccount, to: string): void {
  if (isPhoneAllowed(account, to)) return;
  throw new Error(
    `plivo-sms: outbound blocked — ${to} is not in channels.plivo-sms.allowFrom. ` +
      `Add it to the config to permit sends.`,
  );
}

export const plivoSmsPlugin = createChatChannelPlugin<ResolvedAccount>({
  // @ts-expect-error — createChannelPluginBase infers capabilities as optional but createChatChannelPlugin requires it
  base: createChannelPluginBase<ResolvedAccount>({
    id: CHANNEL_ID,
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      reply: false,
      reactions: false,
      edit: false,
    },
    config: createHybridChannelConfigBase<ResolvedAccount>({
      sectionKey: CHANNEL_ID,
      listAccountIds: listPlivoSmsAccountIds,
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      defaultAccountId: defaultPlivoSmsAccountId,
      clearBaseFields: [
        "authId",
        "authToken",
        "fromNumber",
        "publicWebhookUrl",
        "webhookPath",
        "allowFrom",
        "dmSecurity",
      ],
    }),
    setup: {
      applyAccountConfig: ({ cfg, input }) => {
        const section = (cfg as PlivoSmsConfig).channels?.[CHANNEL_ID] ?? {};
        // The generic configure flow supplies the single `token` (Auth Token)
        // and reuses `name` for the from number; authId is set in openclaw.json.
        const patch: PlivoSmsAccountConfig = {};
        if (input.token !== undefined) patch.authToken = input.token;
        if (input.name !== undefined) patch.fromNumber = input.name;
        if (input.webhookUrl !== undefined) patch.publicWebhookUrl = input.webhookUrl;
        if (input.webhookPath !== undefined) patch.webhookPath = input.webhookPath;
        return {
          ...cfg,
          channels: {
            ...(cfg as PlivoSmsConfig).channels,
            [CHANNEL_ID]: { ...section, ...patch },
          },
        };
      },
    },
  }),

  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account: ResolvedAccount) => account.dmPolicy ?? "allowlist",
      resolveAllowFrom: (account: ResolvedAccount) => account.allowFrom,
      defaultPolicy: "allowlist",
      normalizeEntry: normalizeAllowFrom,
    },
  },

  pairing: {
    text: {
      idLabel: "Phone number",
      message: "Your verification code is:",
      normalizeAllowEntry: normalizeAllowFrom,
      notify: async ({ cfg, id, message, accountId }: {
        cfg: OpenClawConfig;
        id: string;
        message: string;
        accountId?: string;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, id);
        await client.sendMessage({ from: account.fromNumber!, to: id, text: message });
      },
    },
  },

  threading: { topLevelReplyToMode: "none" },

  messaging: {
    resolveSessionConversation: ({ rawId }: { rawId: string }) => ({ conversationId: rawId }),
  },

  outbound: {
    base: {
      deliveryMode: "direct" as const,
      chunkerMode: "text" as const,
      sendFormattedText: async ({ cfg, to, text, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({ from: account.fromNumber!, to, text });
        return [{ channel: CHANNEL_ID, messageId: result.messageUuid }];
      },
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
      }) => {
        const { account, client } = buildOutboundParams(cfg, accountId);
        assertOutboundAllowed(account, to);
        const result = await client.sendMessage({ from: account.fromNumber!, to, text });
        return { messageId: result.messageUuid };
      },
    },
  },
});
