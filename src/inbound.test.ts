import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { handlePlivoSmsWebhook, setPlivoSmsRuntime } from "./inbound.js";
import { computePlivoSignature } from "./webhook.js";

const AUTH_ID = "test-auth-id";
const AUTH_TOKEN = "secret-token";
const PUBLIC_URL = "https://gw.example.com/plivo-sms/webhook";
const NONCE = "test-nonce-123";

const baseCfg = {
  channels: {
    "plivo-sms": {
      authId: AUTH_ID,
      authToken: AUTH_TOKEN,
      fromNumber: "+15559876543",
      publicWebhookUrl: PUBLIC_URL,
    },
  },
} as any;

function encodeForm(form: Record<string, string>): string {
  return Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function createReq(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = method;
  req.url = "/plivo-sms/webhook";
  req.headers = { "content-length": String(Buffer.byteLength(body)), ...headers };
  return req;
}

function createRes(): ServerResponse & { body: string } {
  const res = {
    statusCode: 200,
    body: "",
    end(chunk?: unknown) {
      res.body = typeof chunk === "string" ? chunk : "";
    },
  } as ServerResponse & { body: string };
  return res;
}

function signedReq(form: Record<string, string>): IncomingMessage {
  const body = encodeForm(form);
  const signature = computePlivoSignature({ url: PUBLIC_URL, nonce: NONCE, authToken: AUTH_TOKEN, form });
  return createReq(
    "POST",
    {
      "content-type": "application/x-www-form-urlencoded",
      "x-plivo-signature-v3": signature,
      "x-plivo-signature-v3-nonce": NONCE,
    },
    body,
  );
}

const validForm = {
  From: "+15551234567",
  To: "+15559876543",
  Text: "Hello from SMS",
  Type: "sms",
  MessageUUID: "msg-abc-123",
};

describe("handlePlivoSmsWebhook", () => {
  let routeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    routeSpy = vi.fn(() => ({ agentId: "default", sessionKey: "k" }));
    const runtime = {
      channel: {
        routing: { resolveAgentRoute: routeSpy },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions"),
          readSessionUpdatedAt: vi.fn(() => undefined),
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn(() => ({})),
          finalizeInboundContext: vi.fn(() => ({})),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
        },
        inbound: { run: vi.fn(async () => undefined) },
      },
    } as unknown as PluginRuntime;
    setPlivoSmsRuntime(runtime);
  });

  it("rejects non-POST requests", async () => {
    const res = createRes();
    await handlePlivoSmsWebhook(createReq("GET", {}, ""), res, baseCfg);
    expect(res.statusCode).toBe(405);
  });

  it("returns 503 when the channel is not configured", async () => {
    const res = createRes();
    const cfgNoAuth = { channels: { "plivo-sms": { authId: AUTH_ID } } } as any;
    await handlePlivoSmsWebhook(signedReq(validForm), res, cfgNoAuth);
    expect(res.statusCode).toBe(503);
  });

  it("rejects an invalid signature", async () => {
    const body = encodeForm(validForm);
    const req = createReq(
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        "x-plivo-signature-v3": "not-a-valid-signature",
        "x-plivo-signature-v3-nonce": NONCE,
      },
      body,
    );
    const res = createRes();
    await handlePlivoSmsWebhook(req, res, baseCfg);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Invalid signature");
  });

  it("rejects a missing signature header (fail closed)", async () => {
    const res = createRes();
    await handlePlivoSmsWebhook(
      createReq("POST", { "content-type": "application/x-www-form-urlencoded" }, encodeForm(validForm)),
      res,
      baseCfg,
    );
    expect(res.statusCode).toBe(403);
  });

  it("rejects a signed but malformed payload", async () => {
    const badForm = { From: "not-a-number", To: "", Text: "", MessageUUID: "" };
    const res = createRes();
    await handlePlivoSmsWebhook(signedReq(badForm), res, baseCfg);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid payload");
  });

  it("acknowledges a valid signed inbound message with 200", async () => {
    const res = createRes();
    await handlePlivoSmsWebhook(signedReq(validForm), res, baseCfg);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("dispatches a signed inbound message whose sender is in the allowlist", async () => {
    const cfg = {
      channels: {
        "plivo-sms": {
          authId: AUTH_ID,
          authToken: AUTH_TOKEN,
          fromNumber: "+15559876543",
          publicWebhookUrl: PUBLIC_URL,
          dmSecurity: "allowlist",
          allowFrom: [validForm.From],
        },
      },
    } as any;
    const res = createRes();
    await handlePlivoSmsWebhook(signedReq(validForm), res, cfg);
    expect(res.statusCode).toBe(200);
    expect(routeSpy).toHaveBeenCalled();
  });

  it("drops a signed inbound message whose sender is not in the allowlist without dispatching", async () => {
    const cfg = {
      channels: {
        "plivo-sms": {
          authId: AUTH_ID,
          authToken: AUTH_TOKEN,
          fromNumber: "+15559876543",
          publicWebhookUrl: PUBLIC_URL,
          dmSecurity: "allowlist",
          allowFrom: ["+19998887777"],
        },
      },
    } as any;
    const res = createRes();
    await handlePlivoSmsWebhook(signedReq(validForm), res, cfg);
    expect(res.statusCode).toBe(200);
    expect(routeSpy).not.toHaveBeenCalled();
  });
});
