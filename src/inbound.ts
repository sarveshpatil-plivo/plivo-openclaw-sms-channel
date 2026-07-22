/** Inbound Plivo SMS webhook: signature verification and dispatch into OpenClaw. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { assertOutboundAllowed, isPhoneAllowed, resolveAccount } from "./channel.js";
import { PlivoClient } from "./client.js";
import type { ResolvedAccount } from "./types.js";
import {
  buildPlivoInboundMessage,
  readPlivoWebhookForm,
  resolvePlivoWebhookSignatureUrl,
  verifyPlivoSignature,
} from "./webhook.js";

const CHANNEL_ID = "plivo-sms";
const CHANNEL_LABEL = "Plivo SMS";

let channelRuntime: PluginRuntime | undefined;

export function setPlivoSmsRuntime(runtime: PluginRuntime): void {
  channelRuntime = runtime;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Handle an inbound Plivo SMS webhook. Plivo POSTs an
 * application/x-www-form-urlencoded body (From, To, Text, MessageUUID) and signs
 * it with X-Plivo-Signature-V3 over the canonical request. We fail closed on any
 * missing config, unreadable body, bad signature, or malformed payload.
 */
export async function handlePlivoSmsWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  if (!channelRuntime) {
    res.statusCode = 500;
    res.end("Runtime not ready");
    return;
  }

  let account: ResolvedAccount;
  try {
    account = resolveAccount(cfg, null);
  } catch {
    res.statusCode = 503;
    res.end("Webhook not configured");
    return;
  }

  let form: Record<string, string>;
  try {
    form = await readPlivoWebhookForm(req);
  } catch {
    res.statusCode = 400;
    res.end("Failed to read body");
    return;
  }

  const isValid = verifyPlivoSignature({
    signature: headerValue(req.headers["x-plivo-signature-v3"]),
    nonce: headerValue(req.headers["x-plivo-signature-v3-nonce"]),
    url: resolvePlivoWebhookSignatureUrl({ req, publicWebhookUrl: account.publicWebhookUrl ?? "" }),
    authToken: account.authToken,
    form,
  });
  if (!isValid) {
    res.statusCode = 403;
    res.end("Invalid signature");
    return;
  }

  const inbound = buildPlivoInboundMessage(form);
  if (!inbound) {
    res.statusCode = 400;
    res.end("Invalid payload");
    return;
  }

  // Fail closed on inbound: an allowlisted config must gate the SENDER before the
  // agent runs, not only the reply. A validly-signed request from a number outside
  // allowFrom is ACKed (so Plivo does not retry) but never dispatched to the agent.
  if (!isPhoneAllowed(account, inbound.from)) {
    res.statusCode = 200;
    res.end("OK");
    return;
  }

  // Plivo expects a prompt 2xx acknowledgement to avoid webhook retries. Once
  // authenticated, validated, and authorized, ACK before dispatching into OpenClaw.
  res.statusCode = 200;
  res.end("OK");

  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: channelRuntime,
      channel: CHANNEL_ID,
      channelLabel: CHANNEL_LABEL,
      accountId: "default",
      peer: { kind: "direct", id: inbound.from },
      senderId: inbound.from,
      senderAddress: inbound.from,
      recipientAddress: inbound.to,
      conversationLabel: inbound.from,
      rawBody: inbound.text,
      messageId: inbound.messageUuid,
      deliver: async (payload: { text?: string }) => {
        const replyAccount = resolveAccount(cfg, null);
        if (!replyAccount.fromNumber) return;
        assertOutboundAllowed(replyAccount, inbound.from);
        const client = new PlivoClient(replyAccount.authId, replyAccount.authToken);
        await client.sendMessage({
          from: replyAccount.fromNumber,
          to: inbound.from,
          text: payload.text ?? "",
        });
      },
      onRecordError: (err: unknown) => {
        console.error("[plivo-sms] session record error:", err);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        console.error(`[plivo-sms] dispatch error (${info.kind}):`, err);
      },
    });
  } catch (err) {
    console.error("[plivo-sms] inbound dispatch error:", err);
  }
}
