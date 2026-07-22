<!-- markdownlint-disable MD013 -->

# Plivo SMS Channel for OpenClaw

Give an OpenClaw agent a Plivo phone number, then let people text it over SMS. This is a standalone channel plugin. It does not modify OpenClaw core and it does not replace the bundled SMS (Twilio) channel; it adds an independent `plivo-sms` channel.

> **When to use this vs the Plivo tools plugin.** Install this channel if you want people to converse with your agent over SMS, meaning inbound texts and outbound replies. Install the Plivo tools plugin (`plivo-openclaw-tools`) instead, or as well, if you want the agent to take Plivo actions such as sending an SMS, placing a call, looking up a number, or running a Verify OTP flow as steps inside a task.

## Highlights

- Send and receive SMS through the Plivo Messages API.
- Signed inbound webhooks verified with `X-Plivo-Signature-V3` (HMAC-SHA256).
- Allowlist DM security by default, with an optional open mode.
- Fails closed on missing config, unreadable body, bad signature, or malformed payload.
- SSRF-guarded egress to `api.plivo.com` only.

## Prerequisites

- OpenClaw `2026.4.21` or later.
- A Plivo account with an SMS-capable phone number.
- Your Plivo Auth ID and Auth Token from <https://cx.plivo.com>.
- A public URL that reaches your OpenClaw gateway (for inbound webhooks).

## Install

From ClawHub:

```sh
openclaw plugins install clawhub:plivo-openclaw-sms-channel
```

From source:

```sh
git clone https://github.com/sarveshpatil-plivo/plivo-openclaw-sms-channel.git
cd plivo-openclaw-sms-channel
npm install
npm run build
```

## Configuration

Minimal config in `openclaw.json`:

```json
{
  "channels": {
    "plivo-sms": {
      "authId": "MA...",
      "authToken": "your-plivo-auth-token",
      "fromNumber": "+15551234567",
      "publicWebhookUrl": "https://agent.example.com/plivo-sms/webhook",
      "allowFrom": ["+15557654321"]
    }
  }
}
```

Point your Plivo application's Message URL at the `publicWebhookUrl` above (method POST). Configure it in the Plivo Console at <https://cx.plivo.com>.

### Configuration reference

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `authId` | string | Yes | — | Plivo Auth ID from <https://cx.plivo.com>. |
| `authToken` | string | Yes | — | Plivo Auth Token. Signs and verifies inbound webhooks; keep it secret. |
| `fromNumber` | string | For outbound | — | E.164 Plivo number or sender ID used for outbound SMS. |
| `publicWebhookUrl` | string | For inbound | — | Public URL Plivo posts to. Used to reconstruct the signed URL for verification. |
| `webhookPath` | string | No | `/plivo-sms/webhook` | Local OpenClaw route for Plivo webhooks. |
| `dmSecurity` | string | No | `allowlist` | DM policy: `allowlist` or `open`. |
| `allowFrom` | string[] | No | `[]` | E.164 numbers allowed to message the agent in allowlist mode. |

## Message flow

Inbound: a user texts your Plivo number, Plivo POSTs a signed webhook to `publicWebhookUrl`, the plugin verifies the `X-Plivo-Signature-V3` signature, checks the sender against `dmSecurity`/`allowFrom`, and dispatches the message to the agent. The agent's reply is sent back through the Plivo Messages API.

Outbound: OpenClaw sends through the `plivo-sms` channel; in allowlist mode the recipient must be in `allowFrom`; the message is sent via `POST https://api.plivo.com/v1/Account/{authId}/Message/`.

## Security model

- Inbound webhooks are verified with `X-Plivo-Signature-V3` using your Auth Token. Requests without a valid signature (or without `publicWebhookUrl` configured) are rejected.
- `allowlist` is the default DM security mode; outbound sends honor `allowFrom` in allowlist mode.
- Egress is restricted to `api.plivo.com` over HTTPS.
- Keep your Auth Token in OpenClaw config or secrets, never in source control.

## Limitations (v0.1.0)

- SMS only. MMS/media is not sent or parsed.
- Single account. Named multi-account maps (multiple numbers from one gateway) are not yet supported; use one `channels.plivo-sms` section.

## Package identity

- npm package: `plivo-openclaw-sms-channel` (unscoped).
- OpenClaw channel id: `plivo-sms`.
- The ClawHub owner/scope (for example `@plivo` vs a personal owner) is chosen at publish time via `clawhub publish --owner` and is still pending. It is intentionally not encoded in this package.

## Get a Plivo account

Sign up at [cx.plivo.com](https://cx.plivo.com/?utm_source=github&utm_medium=oss&utm_campaign=plivo-openclaw-sms-channel).

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
