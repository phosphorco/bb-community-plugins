export const MAX_REFERENCE_URL_BYTES = 512;
export const MAX_REFERENCE_LABEL_BYTES = 256;

const encoder = new TextEncoder();
const sensitiveUrlParameterNames = new Set([
  "access_token", "api_key", "apikey", "authorization", "code", "cookie",
  "id_token", "password", "passwd", "refresh_token", "secret", "session",
  "sessionid", "sid", "sig", "signature", "token", "x-amz-credential",
  "x-amz-security-token", "x-amz-signature", "x-goog-credential",
  "x-goog-signature", "x-ms-signature",
]);

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function hasSensitiveUrlParameter(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (sensitiveUrlParameterNames.has(name.toLowerCase())) return true;
  }
  if (url.hash.startsWith("#")) {
    for (const name of new URLSearchParams(url.hash.slice(1)).keys()) {
      if (sensitiveUrlParameterNames.has(name.toLowerCase())) return true;
    }
  }
  return false;
}

export function referenceLabelError(value: string): string | null {
  if (value.trim().length === 0) return "Give this external reference a name.";
  if (utf8ByteLength(value) > MAX_REFERENCE_LABEL_BYTES) {
    return `Reference names are limited to ${MAX_REFERENCE_LABEL_BYTES} UTF-8 bytes.`;
  }
  return null;
}
