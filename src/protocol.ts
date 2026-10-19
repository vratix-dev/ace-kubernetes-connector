// Wire protocol between the connector and Ace. Changes here are contract changes:
// regenerate contract/protocol.json with `npm run contract`.
import { z } from 'zod'

const name = z.string().min(1).max(253).regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
export const kubernetesResources = {
  pods: { api: 'v1', namespaced: true },
  services: { api: 'v1', namespaced: true },
  endpoints: { api: 'v1', namespaced: true },
  configmaps: { api: 'v1', namespaced: true },
  secrets: { api: 'v1', namespaced: true },
  events: { api: 'v1', namespaced: true },
  persistentvolumeclaims: { api: 'v1', namespaced: true },
  resourcequotas: { api: 'v1', namespaced: true },
  limitranges: { api: 'v1', namespaced: true },
  serviceaccounts: { api: 'v1', namespaced: true },
  deployments: { api: 'apps/v1', namespaced: true },
  replicasets: { api: 'apps/v1', namespaced: true },
  statefulsets: { api: 'apps/v1', namespaced: true },
  daemonsets: { api: 'apps/v1', namespaced: true },
  controllerrevisions: { api: 'apps/v1', namespaced: true },
  jobs: { api: 'batch/v1', namespaced: true },
  cronjobs: { api: 'batch/v1', namespaced: true },
  ingresses: { api: 'networking.k8s.io/v1', namespaced: true },
  networkpolicies: { api: 'networking.k8s.io/v1', namespaced: true },
  endpointslices: { api: 'discovery.k8s.io/v1', namespaced: true },
  horizontalpodautoscalers: { api: 'autoscaling/v2', namespaced: true },
  poddisruptionbudgets: { api: 'policy/v1', namespaced: true },
  roles: { api: 'rbac.authorization.k8s.io/v1', namespaced: true },
  rolebindings: { api: 'rbac.authorization.k8s.io/v1', namespaced: true },
  nodes: { api: 'v1', namespaced: false },
  namespaces: { api: 'v1', namespaced: false },
  persistentvolumes: { api: 'v1', namespaced: false },
  storageclasses: { api: 'storage.k8s.io/v1', namespaced: false },
  clusterroles: { api: 'rbac.authorization.k8s.io/v1', namespaced: false },
  clusterrolebindings: { api: 'rbac.authorization.k8s.io/v1', namespaced: false },
  mutatingwebhookconfigurations: { api: 'admissionregistration.k8s.io/v1', namespaced: false },
  validatingwebhookconfigurations: { api: 'admissionregistration.k8s.io/v1', namespaced: false },
} as const
export const kubernetesResourceSchema = z.enum(Object.keys(kubernetesResources) as [keyof typeof kubernetesResources, ...Array<keyof typeof kubernetesResources>])
export const kubernetesRefSchema = z.object({ resource: kubernetesResourceSchema, namespace: name.nullable(), name }).strict()
export type KubernetesRef = z.infer<typeof kubernetesRefSchema>
export const kubernetesReadSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), resource: kubernetesResourceSchema, namespace: name.nullable(), selector: z.string().max(500).optional(), continueToken: z.string().max(4096).optional(), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  z.object({ operation: z.literal('get'), ref: kubernetesRefSchema }).strict(),
  z.object({ operation: z.literal('logs'), namespace: name, pod: name, container: name, previous: z.boolean().default(false), sinceTime: z.string().datetime({ offset: true }), tailLines: z.number().int().min(1).max(300).default(150) }).strict(),
  z.object({ operation: z.literal('access'), resource: kubernetesResourceSchema, namespace: name.nullable(), verb: z.enum(['get', 'list', 'patch', 'create', 'delete']), subresource: z.literal('exec').optional() }).strict(),
  z.object({ operation: z.literal('identity') }).strict(),
])
export type KubernetesRead = z.infer<typeof kubernetesReadSchema>
const patch = z.object({ op: z.enum(['add', 'remove', 'replace', 'test']), path: z.string().min(1).max(500).startsWith('/'), value: z.unknown().optional() }).strict().refine(item => item.op === 'remove' || Object.hasOwn(item, 'value'), 'This patch operation requires a value.')
export const kubernetesMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('patch'), ref: kubernetesRefSchema, uid: z.string().min(1).max(200), resourceVersion: z.string().min(1).max(200), patch: z.array(patch).min(1).max(40) }).strict(),
  z.object({ operation: z.literal('delete'), ref: kubernetesRefSchema, uid: z.string().min(1).max(200), resourceVersion: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('create'), ref: kubernetesRefSchema, manifest: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ operation: z.literal('exec'), ref: kubernetesRefSchema.extend({ resource: z.literal('pods'), namespace: name }), uid: z.string().min(1).max(200), container: name, argv: z.array(z.string().min(1).max(4000)).min(1).max(30) }).strict(),
])
export type KubernetesMutation = z.infer<typeof kubernetesMutationSchema>
export const kubernetesCommandSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('read'), query: kubernetesReadSchema }).strict(),
  z.object({ mode: z.literal('write'), mutation: kubernetesMutationSchema, dryRun: z.boolean() }).strict(),
])
export type KubernetesCommand = z.infer<typeof kubernetesCommandSchema>
export const connectorScopeSchema = z.object({
  clusterName: name,
  namespaces: z.array(name).min(1).max(50),
  clusterResources: z.boolean().default(false),
}).strict()
export type ConnectorScope = z.infer<typeof connectorScopeSchema>
export const connectorResultSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  data: z.unknown(),
  truncated: z.boolean(),
  error: z.enum(['forbidden', 'not_found', 'conflict', 'throttled', 'unavailable', 'invalid', 'ambiguous']).nullable(),
}).strict()
export type ConnectorResult = z.infer<typeof connectorResultSchema>

export function resourcePath(ref: { resource: keyof typeof kubernetesResources; namespace: string | null; name?: string }): string {
  const spec = kubernetesResources[ref.resource]
  if (spec.namespaced !== Boolean(ref.namespace)) throw new Error('Resource namespace does not match its API scope.')
  const base = spec.api === 'v1' ? '/api/v1' : `/apis/${spec.api}`
  return `${base}${ref.namespace ? `/namespaces/${encodeURIComponent(ref.namespace)}` : ''}/${ref.resource}${ref.name ? `/${encodeURIComponent(ref.name)}` : ''}`
}

export function assertConnectorScope(command: KubernetesCommand, scope: ConnectorScope, mode: 'read' | 'write'): void {
  if (command.mode === 'write' && mode !== 'write') throw new Error('The read connector cannot execute mutations.')
  const query = command.mode === 'read' ? command.query : command.mutation
  if (query.operation === 'identity') return
  const namespace = 'ref' in query ? query.ref.namespace : query.namespace
  const resource = query.operation === 'logs' ? 'pods' : 'ref' in query ? query.ref.resource : query.resource
  if (namespace ? !scope.namespaces.includes(namespace) : !scope.clusterResources) throw new Error('The request is outside the connector scope.')
  if (kubernetesResources[resource].namespaced !== Boolean(namespace)) throw new Error('A concrete namespace is required for namespaced resources.')
  if (command.mode === 'write' && resource === 'secrets') throw new Error('The connector does not mutate Secrets.')
}
