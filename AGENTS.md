# AGENTS.md — plivo-openclaw-sms-channel

Integration context for agents working on this package.

## What this is

A standalone external OpenClaw channel plugin that adds a `plivo-sms` channel (SMS via the Plivo Messages API). It is modeled file-for-file on the official `team-telnyx/telnyx-openclaw-sms-channel` vendor plugin. It is NOT a fork of the bundled `@openclaw/sms` (Twilio) channel and it does not modify OpenClaw core. This is the shape ClawSweeper asked for when it closed the core provider-in-core request and pointed to ClawHub.

## Ground truth (do not re-derive from memory)

- Plivo API behavior, the `X-Plivo-Signature-V3` algorithm, and the outbound Messages API contract are ported from the live-tested OpenClaw bundled SMS plugin at `extensions/sms/src/plivo.ts` (and `plivo.test.ts`). The golden signature vector in `src/webhook.test.ts` comes from there. If you change signing or send logic, re-verify against that source, not from recall.
- Structure (entry contracts, manifest shape, tsconfig, package `openclaw` block, register pattern, near-zero inline comments) mirrors the Telnyx template.

## Layout

- `index.ts` — `defineChannelPluginEntry`; mounts the inbound webhook route synchronously in `registerFull`, sets the runtime.
- `setup-entry.ts` — `defineSetupPluginEntry`.
- `src/channel.ts` — channel plugin (`createChatChannelPlugin`), config resolution, allowlist enforcement, outbound send.
- `src/client.ts` — `PlivoClient`, the Messages API client (Basic auth, `{src,dst,text,type:"sms"}`, SSRF-guarded egress, structured errors, message_uuid required).
- `src/webhook.ts` — `X-Plivo-Signature-V3` HMAC-SHA256 verification, form parsing, inbound message building.
- `src/inbound.ts` — webhook handler; verifies signature, dispatches via `dispatchInboundDirectDmWithRuntime`, delivers replies.
- `src/types.ts`, `src/phone.ts` — local types and E.164 helpers.

## Register invariant

The OpenClaw plugin loader closes the guarded `api` proxy as soon as the synchronous part of `register` returns. `api.registerHttpRoute` MUST be called synchronously before any `await`, or the route silently never reaches the gateway. Plivo has no async setup (no messaging-profile discovery, tunnel exposure, webhook auto-config, or watchdog — those are Telnyx-only and are intentionally omitted), so `registerFull` stays a sync prelude.

## Signature verification

Inbound uses header `X-Plivo-Signature-V3` and nonce `X-Plivo-Signature-V3-Nonce`. The signed string is `path + "?" + optional-sorted-query + "." + separator-less-sorted-body-params + "." + nonce`, HMAC-SHA256 with the Auth Token, base64. The header may carry comma-separated signatures; any constant-time match passes. The signed URL is reconstructed from `publicWebhookUrl` plus the request query, so `publicWebhookUrl` must match what Plivo posts to. Missing `publicWebhookUrl` or Auth Token means verification fails closed.

## Config surface

Single account for v0.1.0: `authId`, `authToken` (secret), `fromNumber`, `publicWebhookUrl`, `webhookPath` (default `/plivo-sms/webhook`), `dmSecurity` (`allowlist`|`open`, default `allowlist`), `allowFrom[]`. No named `accounts` map yet (flagged in README).

## Conventions

- Any Plivo Console link is `https://cx.plivo.com`, never `console.plivo.com`.
- README signup link carries `?utm_source=github&utm_medium=oss&utm_campaign=plivo-openclaw-sms-channel` (docs only, not code).
- Keep inline comments to short file headers plus load-bearing invariants only; match Telnyx density.
- devDependency versions are pinned to the Telnyx template's versions.

## Publishing

The ClawHub owner/scope (`@plivo` vs personal) is chosen only at `clawhub publish --owner`; do not encode it in `package.json`. Do not publish without explicit approval.

## Verify

`npm install`, then `npm run typecheck` and `npm test`.
