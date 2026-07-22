/** Plivo Messages API client. Ported from the live-tested OpenClaw SMS plugin. */

import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { PlivoSendMessageParams, PlivoSendResult } from "./types.js";

const PLIVO_ACCOUNT_URL = "https://api.plivo.com/v1/Account";
const PLIVO_API_HOSTNAME = "api.plivo.com";
const PLIVO_API_TIMEOUT_MS = 30_000;
const PLIVO_API_SUCCESS_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const PLIVO_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

type PlivoApiResponse = {
  ok: boolean;
  status: number;
  text: string;
};

function parsePlivoApiError(text: string): { error?: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return { error: typeof record.error === "string" ? record.error : undefined };
  } catch {
    return {};
  }
}

function parsePlivoMessageUuids(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Plivo SMS send returned malformed JSON.");
    }
    const record = parsed as Record<string, unknown>;
    const rawUuids = record.message_uuid;
    return Array.isArray(rawUuids)
      ? rawUuids.filter((uuid): uuid is string => typeof uuid === "string")
      : [];
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Plivo SMS send returned malformed JSON.") {
      throw cause;
    }
    throw new Error("Plivo SMS send returned malformed JSON.", { cause });
  }
}

export class PlivoSmsApiError extends Error {
  readonly httpStatus: number;
  readonly responseText: string;

  constructor(httpStatus: number, responseText: string, operation = "send") {
    const parsed = parsePlivoApiError(responseText);
    const detail = parsed.error ?? (responseText || "unknown");
    super(`Plivo SMS ${operation} failed (${httpStatus}): ${detail}`);
    this.name = "PlivoSmsApiError";
    this.httpStatus = httpStatus;
    this.responseText = responseText;
  }
}

function basicAuthHeader(authId: string, authToken: string): string {
  return `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`;
}

async function readPlivoApiResponseText(response: Response): Promise<string> {
  if (response.ok) {
    const bytes = await readResponseWithLimit(response, PLIVO_API_SUCCESS_BODY_LIMIT_BYTES, {
      onOverflow: ({ size, maxBytes: max }) =>
        new Error(`Plivo SMS API response body too large: ${size} bytes (limit: ${max} bytes)`),
    });
    return new TextDecoder().decode(bytes);
  }
  // An oversized error body must never mask the HTTP status: truncate instead of
  // throwing so the caller still builds a PlivoSmsApiError carrying the status.
  try {
    const bytes = await readResponseWithLimit(response, PLIVO_API_ERROR_BODY_LIMIT_BYTES, {
      onOverflow: () => new Error("error body too large"),
    });
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(Object.entries(headers));
}

/**
 * Plivo Messages API client.
 *
 * Egress is guarded by the SDK SSRF policy (api.plivo.com only, HTTPS) unless a
 * fetch implementation is injected for tests. A successful send must echo a
 * message_uuid; a missing one is treated as a failure rather than a phantom
 * success.
 */
export class PlivoClient {
  private authId: string;
  private authToken: string;
  private fetchImpl?: typeof fetch;

  constructor(authId: string, authToken: string, fetchImpl?: typeof fetch) {
    this.authId = authId;
    this.authToken = authToken;
    this.fetchImpl = fetchImpl;
  }

  private async request(url: string, init: RequestInit): Promise<PlivoApiResponse> {
    const withAuth = {
      ...init,
      headers: {
        ...normalizeRequestHeaders(init.headers),
        authorization: basicAuthHeader(this.authId, this.authToken),
      },
    } satisfies RequestInit;
    if (this.fetchImpl) {
      const response = await this.fetchImpl(url, withAuth);
      return {
        ok: response.ok,
        status: response.status,
        text: await readPlivoApiResponseText(response),
      };
    }
    const guarded = await fetchWithSsrFGuard({
      url,
      init: withAuth,
      auditContext: "plivo-sms-api",
      policy: { allowedHostnames: [PLIVO_API_HOSTNAME] },
      requireHttps: true,
      timeoutMs: PLIVO_API_TIMEOUT_MS,
    });
    try {
      return {
        ok: guarded.response.ok,
        status: guarded.response.status,
        text: await readPlivoApiResponseText(guarded.response),
      };
    } finally {
      await guarded.release();
    }
  }

  async sendMessage(params: PlivoSendMessageParams): Promise<PlivoSendResult> {
    if (!this.authId) {
      throw new Error("Plivo SMS send requires authId.");
    }
    if (!params.from) {
      throw new Error("Plivo SMS send requires fromNumber.");
    }
    const response = await this.request(
      `${PLIVO_ACCOUNT_URL}/${encodeURIComponent(this.authId)}/Message/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          src: params.from,
          dst: params.to,
          text: params.text,
          type: "sms",
        }),
      },
    );
    if (!response.ok) {
      throw new PlivoSmsApiError(response.status, response.text);
    }
    const messageUuid = parsePlivoMessageUuids(response.text)[0]?.trim();
    if (!messageUuid) {
      throw new Error("Plivo SMS send response did not include a message_uuid.");
    }
    return { messageUuid, to: params.to, from: params.from };
  }
}
