import { redactSensitiveText } from './redact'

const sensitive = /password|passwd|secret|token|credential|private.?key|authorization|cookie|connection.?string/i
const omitted = new Set(['managedFields', 'kubectl.kubernetes.io/last-applied-configuration'])
export const retainedAnnotations = ['deployment.kubernetes.io/revision', 'kubectl.kubernetes.io/restartedAt']

// Secret volume sources name a Secret; the names explain stale-credential
// incidents without disclosing values. Other fields under them stay sanitized.
const objectName = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
function secretReference(key: string, item: unknown): boolean {
  if (key === 'secretName') return typeof item === 'string' && item.length <= 253 && objectName.test(item)
  return key === 'secret' && Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof (item as { secretName?: unknown }).secretName === 'string'
}

/** Applied to every result before it leaves the cluster. */
export function sanitizeKubernetes(value: unknown, depth = 0): unknown {
  if (depth > 18) return '[depth limited]'
  if (typeof value === 'string') return redactSensitiveText(value, { maxLength: 4000, redactEmail: true })
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeKubernetes(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (object.kind === 'Secret') return { apiVersion: object.apiVersion, kind: 'Secret', metadata: sanitizeKubernetes(object.metadata, depth + 1), type: object.type, keys: Object.keys((object.data ?? {}) as object).slice(0, 100) }
  const entries = Object.entries(object).slice(0, 200)
  return Object.fromEntries(entries.filter(([key]) => !omitted.has(key)).map(([key, item]) => {
    // Environment literal values are not an appropriate credential boundary.
    if (sensitive.test(key) && !/^(secretKeyRef|secretRef|imagePullSecrets)$/.test(key) && !secretReference(key, item) || key === 'value' && typeof object.name === 'string') return [key, '[redacted]']
    if (key === 'annotations') return [key, Object.fromEntries(Object.entries((item ?? {}) as object).filter(([name]) => retainedAnnotations.includes(name)))]
    return [key, sanitizeKubernetes(item, depth + 1)]
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

