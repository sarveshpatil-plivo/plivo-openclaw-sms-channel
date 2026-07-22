/** Plivo webhook signature (X-Plivo-Signature-V3) and inbound parsing. Ported from the live-tested OpenClaw SMS plugin. */

import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as querystring from "node:querystring";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { looksLikePhoneNumber, normalizePhoneNumber } from "./phone.js";
import type { PlivoInboundMessage } from "./types.js";

const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === "string" ? value : "";
}

function firstTrimmedString(value: unknown): string {
  return firstString(value).trim();
}

export function parsePlivoFormBody(body: string): Record<string, string> {
  const parsed = querystring.parse(body);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = firstString(value);
  }
  return out;
}

export async function readPlivoWebhookForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readRequestBodyWithLimit(req, {
    maxBytes: WEBHOOK_BODY_LIMIT_BYTES,
    timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
  });
  return parsePlivoFormBody(body);
}

function requestSearch(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").search;
  } catch {
    return "";
  }
}

function stripUrlFragment(url: string): string {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

export function resolvePlivoWebhookSignatureUrl(params: {
  req: IncomingMessage;
  publicWebhookUrl: string;
}): string {
  // OpenClaw connection overrides live in the fragment but never reach Plivo's
  // signed input. Strip without reserialization so exact port/path bytes survive.
  const signatureBaseUrl = stripUrlFragment(params.publicWebhookUrl);
  if (signatureBaseUrl.includes("?")) {
    return signatureBaseUrl;
  }
  const search = requestSearch(params.req);
  if (!search) {
    return signatureBaseUrl;
  }
  return `${signatureBaseUrl}${search}`;
}

function splitUrlQuery(url: string): { base: string; query: string } {
  const withoutFragment = stripUrlFragment(url);
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex === -1) {
    return { base: withoutFragment, query: "" };
  }
  return {
    base: withoutFragment.slice(0, queryIndex),
    query: withoutFragment.slice(queryIndex + 1),
  };
}

function sortedQueryString(query: string): string {
  const params = new URLSearchParams(query);
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function sortedParamsString(form: Record<string, string>): string {
  return [...Object.keys(form)]
    .sort()
    .map((key) => `${key}${form[key] ?? ""}`)
    .join("");
}

export function computePlivoSignature(params: {
  url: string;
  nonce: string;
  authToken: string;
  form: Record<string, string>;
}): string {
  // POST V3 canonical string: path, a literal "?", the optional sorted query
  // then ".", the separator-less sorted body params, then "." + nonce.
  const { base, query } = splitUrlQuery(params.url);
  const querySegment = query ? `${sortedQueryString(query)}.` : "";
  const signedString = `${base}?${querySegment}${sortedParamsString(params.form)}.${params.nonce}`;
  return createHmac("sha256", params.authToken).update(signedString).digest("base64");
}

export function verifyPlivoSignature(params: {
  signature: string | undefined;
  nonce: string | undefined;
  url: string;
  authToken: string;
  form: Record<string, string>;
}): boolean {
  if (!params.signature || !params.nonce || !params.url || !params.authToken) {
    return false;
  }
  const expected = computePlivoSignature({
    url: params.url,
    nonce: params.nonce,
    authToken: params.authToken,
    form: params.form,
  });
  // The header can carry several comma-separated signatures; match any in
  // constant time and never infer validity from an absent mismatch.
  return params.signature
    .split(",")
    .some((candidate) => safeEqualSecret(candidate.trim(), expected));
}

export function resolvePlivoMessageUuid(form: Record<string, string>): string {
  return firstTrimmedString(form.MessageUUID);
}

export function buildPlivoInboundMessage(form: Record<string, string>): PlivoInboundMessage | null {
  // Signature verification owns the untouched form; canonicalize the sender
  // only after that boundary so it never changes the signed input.
  const rawFrom = normalizePhoneNumber(firstTrimmedString(form.From));
  const from = looksLikePhoneNumber(rawFrom) ? rawFrom : "";
  const to = firstTrimmedString(form.To);
  const text = firstString(form.Text);
  const messageUuid = resolvePlivoMessageUuid(form);
  if (!from || !to || !text || !messageUuid) {
    return null;
  }
  return { from, to, text, messageUuid };
}
