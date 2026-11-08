import { createHash, createHmac, randomBytes } from 'node:crypto'
import { redactSensitiveText, SECRET_KEY } from './redact'

const sensitiveKey = new RegExp(`${SECRET_KEY}|secret|credential|connection.?string|dsn|(?:^|[-_.])pass(?:$|[-_.])`, 'i')
// dbPass, but not bypass.
const sensitive = (key: string) => sensitiveKey.test(key) || /[a-z]Pass$/.test(key)
const omitted = new Set(['managedFields', 'kubectl.kubernetes.io/last-applied-configuration'])
// Revisions and restarts, plus the GitOps ownership and rollout revision Ace needs to tell who reconciles an object.
export const retainedAnnotations = ['deployment.kubernetes.io/revision', 'kubectl.kubernetes.io/restartedAt', 'argocd.argoproj.io/tracking-id', 'rollout.argoproj.io/revision']

// Secret volume sources name a Secret; the names explain stale-credential
// incidents without disclosing values. Other fields under them stay sanitized.
const objectName = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
function secretReference(key: string, item: unknown): boolean {
  if (key === 'secretName') return typeof item === 'string' && item.length <= 253 && objectName.test(item)
  return key === 'secret' && Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof (item as { secretName?: unknown }).secretName === 'string'
}

/** Applied to every result before it leaves the cluster. */
/** Configured values hold whatever a chart or overlay is given, credentials included: only their shape is kept. */
function redactLeaves(value: unknown, depth: number): unknown {
  if (depth > 18) return '[depth limited]'
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactLeaves(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, redactLeaves(item, depth + 1)]))
  return value === null || value === undefined ? value : '[redacted]'
}

/** Where a value sits: the key that holds it, and the kind of the object (or list) it belongs to. */
interface Place { key?: string; kind?: unknown }

/** Argo CD helm.values / helm.valuesObject, a Flux HelmRelease's spec.values, and a Flux Kustomization's postBuild.substitute. */
const configuredValues = (place: Place, key: string) => place.key === 'helm' && (key === 'values' || key === 'valuesObject') || place.key === 'spec' && place.kind === 'HelmRelease' && key === 'values' || place.key === 'postBuild' && key === 'substitute'

/** A named literal: an env var or Helm parameter's value, or an Argo CD plugin parameter's string, array or map. */
const namedLiteral = (object: Record<string, unknown>, key: string) => typeof object.name === 'string' && /^(value|string|array|map)$/.test(key)

// The reader sends a named literal as a keyed fingerprint, so equal values can be told apart from changed ones
// (across revisions, or a name defined twice) without disclosing either. The key exists only in this process, so
// fingerprints compare within one connector run; its short ID travels with each, and fingerprints with different key
// IDs are not comparable. Every raw value is fingerprinted, one that looks like a fingerprint included, so a cluster
// user cannot copy a fingerprint into a value to make a change look like none.
const fingerprintKey = randomBytes(32)
const fingerprintKeyId = createHash('sha256').update(fingerprintKey).digest('hex').slice(0, 4)
/** The form of a fingerprinted literal. */
export const literalFingerprint = /^\[redacted:[0-9a-f]{4}-[0-9a-f]{8}\]$/
/** One text per value: a string is itself, anything else is JSON with its keys sorted, so key order is not a change. */
const canonical = (value: unknown): string => typeof value === 'string' ? `s${value}` : `j${JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item) ?? ''}`
const fingerprint = (value: unknown) => `[redacted:${fingerprintKeyId}-${createHmac('sha256', fingerprintKey).update(canonical(value)).digest('hex').slice(0, 8)}]`
// Set only for the duration of one synchronous sanitizeKubernetesResult call.
let fingerprinting = false

/** Bytes of a pod log the connector reads, from its end: comfortably more than the text it keeps. */
export const LOG_READ_BYTES = 64_000
/** Pod log bodies keep their newest lines: the failure that matters is usually the last thing a container wrote. */
export const LOG_TEXT_LIMIT = 16_000
const PEM_BEGIN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g, PEM_END = /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
/** A private key cut by a bound has only one of its markers, which ordinary redaction needs both of: remove it to the edge. */
function redactCutKeys(text: string): string {
  const begins = [...text.matchAll(PEM_BEGIN)], ends = [...text.matchAll(PEM_END)]
  const lastBegin = begins.at(-1)?.index ?? -1, lastEnd = ends.at(-1)?.index ?? -1
  if (lastBegin > lastEnd) text = `${text.slice(0, lastBegin)}[REDACTED_PRIVATE_KEY]`
  const firstEnd = ends[0], firstBegin = begins[0]?.index ?? Infinity
  if (firstEnd && firstEnd.index < firstBegin) text = `[REDACTED_PRIVATE_KEY]${text.slice(firstEnd.index + firstEnd[0].length)}`
  return text
}
/**
 * The newest complete lines within the bound, redacted, after a line saying how many earlier lines were left out.
 * The lines are chosen first and only they are redacted, so the cost is bounded whatever the body's size. Applying
 * it again changes nothing.
 */
export function sanitizeLogText(text: string): string {
  let omitted = 0
  let window = text
  if (window.length > LOG_TEXT_LIMIT) {
    const start = window.length - LOG_TEXT_LIMIT + 64
    const next = window.indexOf('\n', start - 1)
    // Keep from the first whole line inside the bound; a single longer line keeps its end.
    const whole = next >= 0 && next < window.length - 1
    const from = whole ? next + 1 : start
    omitted = (window.slice(0, from).match(/\n/g)?.length ?? 0) + (whole ? 0 : 1)
    window = `${whole ? '' : '…'}${window.slice(from)}`
  }
  const redacted = redactSensitiveText(redactCutKeys(window), { maxLength: window.length, redactEmail: true })
  return omitted ? `[${omitted} earlier log lines omitted]\n${redacted}` : redacted
}

/** A whole read result: a log body is text, everything else is an object or list. Only the reader fingerprints. */
export function sanitizeKubernetesResult(value: unknown, options: { fingerprints?: boolean } = {}): unknown {
  if (typeof value === 'string') return sanitizeLogText(value)
  fingerprinting = Boolean(options.fingerprints)
  try { return sanitizeKubernetes(value) } finally { fingerprinting = false }
}

/** Sanitizes before a result leaves the cluster. Ace applies its own copy again before persistence. */
export function sanitizeKubernetes(value: unknown, depth = 0, place: Place = {}): unknown {
  if (depth > 18) return '[depth limited]'
  if (typeof value === 'string') return redactSensitiveText(value, { maxLength: 4000, redactEmail: true })
  // A list response's items carry no kind of their own: a SecretList's items are Secrets.
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeKubernetes(item, depth + 1, place.key === 'items' && typeof place.kind === 'string' && place.kind.endsWith('List') ? { kind: place.kind.slice(0, -4) } : {}))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>, kind = object.kind ?? place.kind
  // A Secret itself. A reference with kind Secret (a Flux valuesFrom, an Argo CD status.resources entry) has no metadata or data and keeps its name.
  if (kind === 'Secret' && ('metadata' in object || 'data' in object || 'stringData' in object)) return { apiVersion: object.apiVersion, kind: 'Secret', metadata: sanitizeKubernetes(object.metadata, depth + 1), type: object.type, ...secretKeys(object, depth) }
  const entries = Object.entries(object).slice(0, 200)
  return Object.fromEntries(entries.filter(([key]) => !omitted.has(key)).map(([key, item]) => {
    // Environment literal values are not an appropriate credential boundary.
    // A credential-named literal is not fingerprinted: even whether it changed stays in the cluster.
    if (namedLiteral(object, key)) return [key, fingerprinting && !sensitive(object.name as string) ? fingerprint(item) : '[redacted]']
    if (sensitive(key) && !/^(secretKeyRef|secretRef|imagePullSecrets|continueToken)$/.test(key) && !secretReference(key, item)) return [key, '[redacted]']
    // An inline Kustomize patch (Argo CD or Flux) can set any field, literal env values included.
    if (key === 'patch' && typeof item === 'string') return [key, '[redacted]']
    if (configuredValues(place, key)) return [key, redactLeaves(item, depth + 1)]
    if (key === 'annotations') return [key, Object.fromEntries(Object.entries((item ?? {}) as object).filter(([name]) => retainedAnnotations.includes(name)))]
    return [key, sanitizeKubernetes(item, depth + 1, { key, kind })]
  }))
}

/**
 * A Secret's key names, never its values. A Secret this connector has already reduced carries only its key names;
 * one read as metadata alone carries none, and then its keys are unknown rather than absent.
 */
function secretKeys(object: Record<string, unknown>, depth: number): { keys?: unknown[] } {
  if ('data' in object || 'stringData' in object) return { keys: [...Object.keys((object.data ?? {}) as object), ...Object.keys((object.stringData ?? {}) as object)].slice(0, 100) }
  if (Array.isArray(object.keys)) return { keys: object.keys.filter(item => typeof item === 'string').slice(0, 100).map(item => sanitizeKubernetes(item, depth + 1)) }
  return {}
}

/** Report bounds separately from redaction, which does not imply missing resources. */
export function kubernetesPayloadTruncated(value: unknown, depth = 0): boolean {
  if (depth > 18) return true
  if (typeof value === 'string') return value.length > (depth === 0 ? LOG_TEXT_LIMIT - 64 : 4000)
  if (Array.isArray(value)) return value.length > 200 || value.some(item => kubernetesPayloadTruncated(item, depth + 1))
  if (value && typeof value === 'object') return Object.keys(value).length > 200 || Object.entries(value).filter(([key]) => !omitted.has(key)).some(([,item]) => kubernetesPayloadTruncated(item, depth + 1))
  return false
}

