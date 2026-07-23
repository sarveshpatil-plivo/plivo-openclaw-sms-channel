import { describe, expect, it, vi } from "vitest";
import { assertOutboundAllowed, resolveAccount } from "./channel.js";
import { PlivoClient, PlivoSmsApiError } from "./client.js";
import type { PlivoSmsConfig, ResolvedAccount } from "./types.js";

function cfg(section: Record<string, unknown>): PlivoSmsConfig {
  return { channels: { "plivo-sms": section } } as unknown as PlivoSmsConfig;
}

function account(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    accountId: null,
    authId: "test-auth-id",
    authToken: "secret",
    fromNumber: "+15557654321",
    publicWebhookUrl: "https://gw.example.com/plivo-sms/webhook",
    webhookPath: "/plivo-sms/webhook",
    allowFrom: [],
    dmPolicy: "allowlist",
    ...overrides,
  };
}

describe("resolveAccount", () => {
  it("resolves the default account", () => {
    const resolved = resolveAccount(
      cfg({ authId: "id", authToken: "tok", fromNumber: "+15551234567", allowFrom: ["+15550001111"] }),
      null,
    );
    expect(resolved.authId).toBe("id");
    expect(resolved.authToken).toBe("tok");
    expect(resolved.fromNumber).toBe("+15551234567");
    expect(resolved.allowFrom).toEqual(["+15550001111"]);
    expect(resolved.accountId).toBeNull();
  });

  it("throws when authId is missing", () => {
    expect(() => resolveAccount(cfg({ authToken: "tok" }), null)).toThrow("authId is required");
  });

  it("throws when authToken is missing", () => {
    expect(() => resolveAccount(cfg({ authId: "id" }), null)).toThrow("authToken is required");
  });

  it("rejects a named account (single-account channel in v0.1.0)", () => {
    expect(() => resolveAccount(cfg({ authId: "id", authToken: "tok" }), "work")).toThrow(
      'account "work" not found',
    );
  });

  it("defaults allowFrom to an empty array", () => {
    expect(resolveAccount(cfg({ authId: "id", authToken: "tok" }), null).allowFrom).toEqual([]);
  });
});

describe("assertOutboundAllowed", () => {
  it("permits any destination in open mode", () => {
    expect(() => assertOutboundAllowed(account({ dmPolicy: "open" }), "+15550009999")).not.toThrow();
  });

  it("blocks all destinations when allowFrom is empty (fail closed)", () => {
    expect(() => assertOutboundAllowed(account({ allowFrom: [] }), "+15550009999")).toThrow("outbound blocked");
  });

  it("permits wildcard allowFrom", () => {
    expect(() => assertOutboundAllowed(account({ allowFrom: ["*"] }), "+15550009999")).not.toThrow();
  });

  it("allows a matching destination and blocks a non-listed one", () => {
    const acct = account({ allowFrom: ["+1 (555) 000-1111"] });
    expect(() => assertOutboundAllowed(acct, "+15550001111")).not.toThrow();
    expect(() => assertOutboundAllowed(acct, "+15559998888")).toThrow("outbound blocked");
  });
});

describe("PlivoClient.sendMessage", () => {
  it("sends SMS through the Messages API and returns the message_uuid", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            message: "message(s) queued",
            message_uuid: ["db3ce55a-7f1d-11e1-8ea7-1231380bc196"],
            api_id: "db342550-7f1d-11e1-8ea7-1231380bc196",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );

    const client = new PlivoClient("test-auth-id", "secret", fetchImpl);
    await expect(
      client.sendMessage({ from: "+15557654321", to: "+15551234567", text: "hello" }),
    ).resolves.toEqual({
      messageUuid: "db3ce55a-7f1d-11e1-8ea7-1231380bc196",
      to: "+15551234567",
      from: "+15557654321",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.plivo.com/v1/Account/test-auth-id/Message/");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("test-auth-id:secret").toString("base64")}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      src: "+15557654321",
      dst: "+15551234567",
      text: "hello",
      type: "sms",
    });
  });

  it("throws a structured error from a JSON error body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "the source number is not valid", api_id: "err-1" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    const client = new PlivoClient("test-auth-id", "secret", fetchImpl);
    await expect(
      client.sendMessage({ from: "+15557654321", to: "+15551234567", text: "hello" }),
    ).rejects.toMatchObject({
      name: "PlivoSmsApiError",
      message: "Plivo SMS send failed (400): the source number is not valid",
      httpStatus: 400,
    });
  });

  it("treats a missing message_uuid as a failure, not a phantom success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: "message(s) queued", message_uuid: [] }), {
          status: 202,
        }),
    );

    const client = new PlivoClient("test-auth-id", "secret", fetchImpl);
    await expect(
      client.sendMessage({ from: "+15557654321", to: "+15551234567", text: "hello" }),
    ).rejects.toThrow("Plivo SMS send response did not include a message_uuid.");
  });

  it("requires authId and fromNumber before sending", async () => {
    await expect(
      new PlivoClient("", "secret").sendMessage({ from: "+1", to: "+2", text: "hi" }),
    ).rejects.toThrow("Plivo SMS send requires authId.");
    await expect(
      new PlivoClient("id", "secret").sendMessage({ from: "", to: "+2", text: "hi" }),
    ).rejects.toThrow("Plivo SMS send requires fromNumber.");
  });

  it("exposes PlivoSmsApiError for instanceof checks", () => {
    expect(new PlivoSmsApiError(400, "{}")).toBeInstanceOf(Error);
  });
});
