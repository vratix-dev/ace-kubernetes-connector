const REDACTED = "[REDACTED]"

const SECRET_KEY =
  String.raw`password|passwd|pwd|secret(?:_?key)?|token|api[_-]?key|authorization|cookie|set-cookie|session[_-]?id|client[_-]?secret|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|refresh[_-]?token|identity[_-]?token|signing[_-]?secret`

const KEY_VALUE_SECRET = new RegExp(
  String.raw`\b(${SECRET_KEY})\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\[[A-Z_]{3,40}\]|[^\s,;}\]]+)`,
  "gi"
)
const JSON_SECRET = new RegExp(
  String.raw`(["'])(${SECRET_KEY})\1(\s*:\s*)(?:"[^"]*"|'[^']*'|\[[A-Z_]{3,40}\]|[^,}\]\s]+)`,
  "gi"
)
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const AUTHORIZATION_ASSIGNMENT =
  /\b(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const AWS_ACCESS_KEY =
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g
const PEM_PRIVATE_KEY =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
const URL_CREDENTIALS =
  /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|ftp):\/\/)[^/\s:@]+:[^/\s@]+@/gi
const SIGNED_URL =
  /\bhttps?:\/\/[^\s"'<>]+(?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|sig=|token=)[^\s"'<>]*/gi
const SENSITIVE_QUERY_PARAM =
  /([?&](?:access_token|api[_-]?key|auth|authorization|code|credential|password|secret|signature|sig|token)=)[^&#\s"'<>]*/gi
const PROVIDER_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,})\b/g
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g

function redactSignedUrl(value: string): string {
  const queryIndex = value.indexOf("?")
  if (queryIndex === -1) return "[REDACTED_SIGNED_URL]"
  return `${value.slice(0, queryIndex)}?[REDACTED_SIGNED_QUERY]`
}


export function redactSensitiveText(
  value: string,
  options: {
    maxLength: number
    redactEmail?: boolean
    redactIpv4?: boolean
    truncationSuffix?: string
  }
): string {
  const truncated = value.length > options.maxLength
  let output = value.slice(0, options.maxLength)

  // Every expression runs against a bounded string. The patterns use linear
  // character classes and fixed alternatives; none contains nested ambiguous
  // quantifiers that can trigger catastrophic backtracking.
  output = output
    .replace(PEM_PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(SIGNED_URL, redactSignedUrl)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_ASSIGNMENT, `$1${REDACTED}`)
    .replace(
      JSON_SECRET,
      (_match, quote: string, key: string, separator: string) =>
        `${quote}${key}${quote}${separator}"${REDACTED}"`
    )
    .replace(
      KEY_VALUE_SECRET,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`
    )
    .replace(AUTHORIZATION_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(AWS_ACCESS_KEY, "[REDACTED_ACCESS_KEY]")
    .replace(PROVIDER_TOKEN, REDACTED)
    .replace(SENSITIVE_QUERY_PARAM, `$1${REDACTED}`)

  if (options.redactEmail !== false) {
    output = output.replace(EMAIL, "[REDACTED_EMAIL]")
  }
  if (options.redactIpv4) {
    output = output.replace(IPV4, "[REDACTED_IP]")
  }
  return truncated ? `${output}${options.truncationSuffix ?? ""}` : output
}
