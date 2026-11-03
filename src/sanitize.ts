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

/** Sanitizes before a result leaves the cluster. Ace applies its own copy again before persistence. */
export function sanitizeKubernetes(value: unknown, depth = 0, place: Place = {}): unknown {
  if (depth > 18) return '[depth limited]'
  if (typeof value === 'string') return redactSensitiveText(value, { maxLength: 4000, redactEmail: true })
  // A list response's items carry no kind of their own: a SecretList's items are Secrets.
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeKubernetes(item, depth + 1, place.key === 'items' && typeof place.kind === 'string' && place.kind.endsWith('List') ? { kind: place.kind.slice(0, -4) } : {}))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>, kind = object.kind ?? place.kind
  // A Secret itself. A reference with kind Secret (a Flux valuesFrom, an Argo CD status.resources entry) has no metadata or data and keeps its name.
  if (kind === 'Secret' && ('metadata' in object || 'data' in object || 'stringData' in object)) return { apiVersion: object.apiVersion, kind: 'Secret', metadata: sanitizeKubernetes(object.metadata, depth + 1), type: object.type, keys: [...Object.keys((object.data ?? {}) as object), ...Object.keys((object.stringData ?? {}) as object)].slice(0, 100) }
  const entries = Object.entries(object).slice(0, 200)
  return Object.fromEntries(entries.filter(([key]) => !omitted.has(key)).map(([key, item]) => {
    // Environment literal values are not an appropriate credential boundary.
    if (sensitive(key) && !/^(secretKeyRef|secretRef|imagePullSecrets|continueToken)$/.test(key) && !secretReference(key, item) || namedLiteral(object, key)) return [key, '[redacted]']
    // An inline Kustomize patch (Argo CD or Flux) can set any field, literal env values included.
    if (key === 'patch' && typeof item === 'string') return [key, '[redacted]']
    if (configuredValues(place, key)) return [key, redactLeaves(item, depth + 1)]
    if (key === 'annotations') return [key, Object.fromEntries(Object.entries((item ?? {}) as object).filter(([name]) => retainedAnnotations.includes(name)))]
    return [key, sanitizeKubernetes(item, depth + 1, { key, kind })]
  }))
}

/** Report bounds separately from redaction, which does not imply missing resources. */
export function kubernetesPayloadTruncated(value: unknown, depth = 0): boolean {
  if (depth > 18) return true
  if (typeof value === 'string') return value.length > 4000
  if (Array.isArray(value)) return value.length > 200 || value.some(item => kubernetesPayloadTruncated(item, depth + 1))
  if (value && typeof value === 'object') return Object.keys(value).length > 200 || Object.entries(value).filter(([key]) => !omitted.has(key)).some(([,item]) => kubernetesPayloadTruncated(item, depth + 1))
  return false
}

