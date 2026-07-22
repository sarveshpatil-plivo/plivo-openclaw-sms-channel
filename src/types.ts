/** Type definitions for the Plivo SMS channel plugin. */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

/** Resolved account config after reading the plivo-sms channel section. */
export interface ResolvedAccount {
  accountId: string | null;
  authId: string;
  authToken: string;
  fromNumber?: string;
  publicWebhookUrl?: string;
  webhookPath?: string;
  allowFrom: string[];
  dmPolicy: "allowlist" | "open" | undefined;
}

/** Plivo Messages API send request body fields the plugin uses. */
export interface PlivoSendMessageParams {
  from: string;
  to: string;
  text: string;
}

/** Normalized result of a successful Plivo send. */
export interface PlivoSendResult {
  messageUuid: string;
  to: string;
  from: string;
}

/** Normalized inbound message parsed from a Plivo webhook form post. */
export interface PlivoInboundMessage {
  from: string;
  to: string;
  text: string;
  messageUuid: string;
}

/** Config shape under channels.plivo-sms. */
export interface PlivoSmsAccountConfig {
  authId?: string;
  authToken?: string;
  fromNumber?: string;
  publicWebhookUrl?: string;
  webhookPath?: string;
  allowFrom?: string[];
  dmSecurity?: "allowlist" | "open";
}

/** Top-level config for resolving the plivo-sms account. */
export type PlivoSmsConfig = OpenClawConfig & {
  channels?: {
    "plivo-sms"?: PlivoSmsAccountConfig;
  };
};
