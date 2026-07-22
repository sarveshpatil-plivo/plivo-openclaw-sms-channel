/** E.164 phone-number normalization helpers for the Plivo SMS channel. */

export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim().replace(/^(?:sms|plivo-sms):/i, "");
  if (!trimmed) {
    return "";
  }
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  return withPlus.replace(/[^\d+]/g, "");
}

export function looksLikePhoneNumber(raw: string): boolean {
  const normalized = normalizePhoneNumber(raw);
  return /^\+[1-9]\d{6,14}$/.test(normalized);
}

export function normalizeAllowFrom(raw: string): string {
  if (raw.trim() === "*") {
    return "*";
  }
  return normalizePhoneNumber(raw).toLowerCase();
}
