import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildPlivoInboundMessage,
  computePlivoSignature,
  parsePlivoFormBody,
  readPlivoWebhookForm,
  resolvePlivoWebhookSignatureUrl,
  verifyPlivoSignature,
} from "./webhook.js";

// Deterministic vector ported from the live-tested OpenClaw SMS plugin
// (plivo-python@989c589 webhook-signature-v3 golden fixture).
const GOLDEN = {
  url: "https://example.com/plivo/inbound",
  nonce: "f4b1c2d3e5",
  authToken: "FAKE_AUTH_TOKEN_1234567890",
  form: {
    From: "+14150000001",
    To: "+14150000002",
    Text: "test",
    Type: "sms",
    MessageUUID: "11111111-2222-3333-4444-555555555555",
  },
  signature: "BsYEsmZvb8pj7+RQtDfliZnZKIBlAmvq4t8a3d6MkXU=",
} as const;

async function readTestPlivoForm(body: string): Promise<Record<string, string>> {
  const req = Readable.from([body]) as IncomingMessage;
  req.headers = { "content-length": String(Buffer.byteLength(body)) };
  return await readPlivoWebhookForm(req);
}

describe("computePlivoSignature", () => {
  it("reproduces the Plivo V3 golden signature", () => {
    expect(
      computePlivoSignature({
        url: GOLDEN.url,
        nonce: GOLDEN.nonce,
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(GOLDEN.signature);
  });
});

describe("verifyPlivoSignature", () => {
  it("verifies a valid X-Plivo-Signature-V3", () => {
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: GOLDEN.nonce,
        url: GOLDEN.url,
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(true);
  });

  it("matches when any comma-separated candidate is valid", () => {
    expect(
      verifyPlivoSignature({
        signature: `wrong-signature,${GOLDEN.signature}`,
        nonce: GOLDEN.nonce,
        url: GOLDEN.url,
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(true);
  });

  it("fails closed on wrong nonce, wrong url, missing nonce, or empty token", () => {
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: "different-nonce",
        url: GOLDEN.url,
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(false);
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: GOLDEN.nonce,
        url: "https://example.com/plivo/other",
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(false);
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: undefined,
        url: GOLDEN.url,
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(false);
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: GOLDEN.nonce,
        url: "",
        authToken: GOLDEN.authToken,
        form: GOLDEN.form,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyPlivoSignature({
        signature: GOLDEN.signature,
        nonce: GOLDEN.nonce,
        url: GOLDEN.url,
        authToken: GOLDEN.authToken,
        form: { ...GOLDEN.form, Text: "tampered" },
      }),
    ).toBe(false);
  });
});

describe("resolvePlivoWebhookSignatureUrl", () => {
  it("appends the request query when the configured URL has none", () => {
    const req = { url: "/plivo-sms/webhook?a=1&b=2" } as IncomingMessage;
    expect(
      resolvePlivoWebhookSignatureUrl({ req, publicWebhookUrl: "https://gw.example.com/plivo-sms/webhook" }),
    ).toBe("https://gw.example.com/plivo-sms/webhook?a=1&b=2");
  });

  it("keeps the configured query and drops the fragment", () => {
    const req = { url: "/plivo-sms/webhook?x=9" } as IncomingMessage;
    expect(
      resolvePlivoWebhookSignatureUrl({
        req,
        publicWebhookUrl: "https://gw.example.com/plivo-sms/webhook?fixed=1#frag",
      }),
    ).toBe("https://gw.example.com/plivo-sms/webhook?fixed=1");
  });
});

describe("parsePlivoFormBody / buildPlivoInboundMessage", () => {
  it("parses a urlencoded body and builds an inbound message", async () => {
    const form = await readTestPlivoForm(
      "From=%2B15551234567&To=%2B15557654321&Text=hello+there&Type=sms&MessageUUID=abc-123",
    );
    expect(form).toEqual({
      From: "+15551234567",
      To: "+15557654321",
      Text: "hello there",
      Type: "sms",
      MessageUUID: "abc-123",
    });
    expect(buildPlivoInboundMessage(form)).toEqual({
      from: "+15551234567",
      to: "+15557654321",
      text: "hello there",
      messageUuid: "abc-123",
    });
  });

  it("returns null for forms missing a phone number or message id", () => {
    expect(
      buildPlivoInboundMessage({ From: "not-a-number", To: "+15557654321", Text: "hi", MessageUUID: "abc" }),
    ).toBeNull();
    expect(
      buildPlivoInboundMessage({ From: "+15551234567", To: "+15557654321", Text: "hi", MessageUUID: "" }),
    ).toBeNull();
    expect(parsePlivoFormBody("")).toEqual({});
  });
});
