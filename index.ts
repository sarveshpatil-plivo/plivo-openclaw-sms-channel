/** Plugin entry: registers the plivo-sms channel and mounts its inbound webhook route. */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { plivoSmsPlugin, resolveAccount } from "./src/channel.js";
import { handlePlivoSmsWebhook, setPlivoSmsRuntime } from "./src/inbound.js";
import type { PlivoSmsConfig } from "./src/types.js";

export default defineChannelPluginEntry({
  id: "plivo-sms",
  name: "Plivo SMS",
  description: "Send and receive SMS via Plivo Messages API",
  plugin: plivoSmsPlugin,

  setRuntime: (runtime) => {
    setPlivoSmsRuntime(runtime);
  },

  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program.command("plivo-sms").description("Plivo SMS channel management");
      },
      {
        descriptors: [
          {
            name: "plivo-sms",
            description: "Plivo SMS channel management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },

  // Register the inbound webhook route synchronously. The OpenClaw plugin loader
  // wraps `api` in a guarded proxy that disables every method as soon as the
  // synchronous portion of `register` returns, so any `api.*` call placed after
  // an `await` becomes a silent no-op and the route would never reach the
  // gateway's HTTP route registry. There is no async setup for Plivo (no
  // discovery, tunnel, or webhook auto-config), so this stays a sync prelude.
  registerFull(api) {
    const cfg = api.config as PlivoSmsConfig;
    const account = cfg?.channels?.["plivo-sms"];
    if (!account) {
      api.logger?.warn?.("[plivo-sms] no channels.plivo-sms config found, skipping registration");
      return;
    }
    const webhookPath = account.webhookPath ?? "/plivo-sms/webhook";

    api.registerHttpRoute({
      path: webhookPath,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        await handlePlivoSmsWebhook(req, res, api.config);
      },
    });
    api.logger?.info?.(`[plivo-sms] registered inbound webhook route at ${webhookPath}`);

    try {
      const resolved = resolveAccount(cfg, null);
      if (!resolved.publicWebhookUrl) {
        api.logger?.warn?.(
          "[plivo-sms] no publicWebhookUrl set — inbound signature verification will reject all requests. " +
            "Set channels.plivo-sms.publicWebhookUrl to the URL Plivo posts to.",
        );
      }
    } catch (err) {
      api.logger?.warn?.(
        `[plivo-sms] channel not fully configured: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});
