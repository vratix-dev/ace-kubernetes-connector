import { describe, it, expect } from 'vitest'
import nock from 'nock'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { KubeConfig } from '@kubernetes/client-node'
import { KubernetesConnectorClient, connectorVersion } from '../src/client'
import { assertConnectorScope, connectorHeartbeatSchema, kubernetesMutationSchema } from '../src/protocol'
import { literalFingerprint, sanitizeKubernetes, sanitizeKubernetesResult, sanitizeLogText } from '../src/sanitize'

const scope = { clusterName: 'test', namespaces: ['shop'], clusterResources: false }
const ref = { resource: 'deployments' as const, namespace: 'shop', name: 'frontend' }
const patch = { operation: 'patch' as const, ref, uid: 'uid-a', resourceVersion: '19', patch: [{ op: 'replace' as const, path: '/spec/replicas', value: 2 }] }
function client(mode: 'read' | 'write' = 'read') {
  const kube = new KubeConfig()
  kube.loadFromOptions({ clusters: [{ name: 'test', server: 'http://127.0.0.1:18445', skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' })
  return new KubernetesConnectorClient(kube, scope, mode)
}

describe('connector scope and local execution', () => {
  it('rejects writes through readers and requests outside concrete namespace scope before contacting Kubernetes', async () => {
    expect(() => assertConnectorScope({ mode: 'write', mutation: patch, dryRun: false }, scope, 'read')).toThrow('read connector')
    expect(() => assertConnectorScope({ mode: 'read', query: { operation: 'list', resource: 'pods', namespace: null, limit: 20 } }, { ...scope, clusterResources: true }, 'read')).toThrow('concrete namespace')
    expect((await client().run({ mode: 'read', query: { operation: 'get', ref: { ...ref, namespace: 'other' } } })).error).toBe('invalid')
    // A cluster-wide connector reads, or writes, any namespace; Secrets stay in the selected namespaces; a limited one stays in its own.
    expect(() => assertConnectorScope({ mode: 'read', query: { operation: 'get', ref: { resource: 'configmaps', namespace: 'kube-system', name: 'coredns' } } }, { ...scope, allNamespaces: true }, 'read')).not.toThrow()
    expect(() => assertConnectorScope({ mode: 'read', query: { operation: 'get', ref: { resource: 'secrets', namespace: 'kube-system', name: 'bootstrap-token' } } }, { ...scope, allNamespaces: true }, 'read')).toThrow('outside the connector scope')
    expect(() => assertConnectorScope({ mode: 'write', mutation: { ...patch, ref: { ...ref, namespace: 'kube-system' } }, dryRun: false }, { ...scope, allNamespaces: true }, 'write')).not.toThrow()
    expect(() => assertConnectorScope({ mode: 'write', mutation: { ...patch, ref: { ...ref, namespace: 'kube-system' } }, dryRun: false }, scope, 'write')).toThrow('outside the connector scope')
    expect(kubernetesMutationSchema.safeParse({ ...patch, patch: [{ op: 'replace', path: '/spec/replicas' }] }).success).toBe(false)
  })
  it('sends exact patch bytes with UID and resource-version preconditions and dry-run', async () => {
    let received: unknown
    const api = nock('http://127.0.0.1:18445').patch('/apis/apps/v1/namespaces/shop/deployments/frontend', body => { received = body; return true }).query({ dryRun: 'All' }).reply(200, { metadata: { uid: 'uid-a', resourceVersion: '19' } })
    const result = await client('write').run({ mode: 'write', mutation: patch, dryRun: true })
    expect(result.error).toBeNull()
    expect(received).toEqual([{ op: 'test', path: '/metadata/uid', value: 'uid-a' }, { op: 'test', path: '/metadata/resourceVersion', value: '19' }, { op: 'replace', path: '/spec/replicas', value: 2 }])
    expect(api.isDone()).toBe(true)
  })
  it('does not replay a mutation after an ambiguous API failure', async () => {
    const api = nock('http://127.0.0.1:18445').patch('/apis/apps/v1/namespaces/shop/deployments/frontend').once().reply(500)
    expect((await client('write').run({ mode: 'write', mutation: patch, dryRun: false })).error).toBe('ambiguous')
    expect(api.isDone()).toBe(true)
  })
  it('reports permission denial and list truncation without claiming missing resources', async () => {
    nock('http://127.0.0.1:18445').get('/api/v1/namespaces/shop/pods').query({ limit: 2 }).reply(200, { items: [{ metadata: { name: 'a', uid: 'a' } }, { metadata: { name: 'b', uid: 'b' } }], metadata: { continue: 'next-page' } })
    const result = await client().run({ mode: 'read', query: { operation: 'list', resource: 'pods', namespace: 'shop', limit: 2 } })
    expect(result).toMatchObject({ error: null, truncated: true, data: { items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] } })
    nock('http://127.0.0.1:18445').get('/apis/apps/v1/namespaces/shop/deployments/frontend').reply(403, { message: 'private details' })
    expect(await client().run({ mode: 'read', query: { operation: 'get', ref } })).toMatchObject({ error: 'forbidden', data: null })
  })
  it('removes secret data and environment literals while retaining references', () => {
    expect(sanitizeKubernetes({ kind: 'Secret', metadata: { name: 'db', uid: 'secret-uid' }, data: { password: 'base64secret' } })).toEqual({ kind: 'Secret', apiVersion: undefined, metadata: { name: 'db', uid: 'secret-uid' }, type: undefined, keys: ['password'] })
    expect(sanitizeKubernetes({ env: [{ name: 'PASSWORD', value: 'never-retain' }, { name: 'DB', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }] })).toEqual({ env: [{ name: 'PASSWORD', value: '[redacted]' }, { name: 'DB', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }] })
  })
  it('retains Secret volume reference names for diagnosis while still redacting credential values', () => {
    const pod = { spec: { volumes: [{ name: 'db', secret: { secretName: 'db-credentials', items: [{ key: 'password', path: 'pw' }] } }], containers: [{ name: 'app', env: [{ name: 'API_TOKEN', value: 'literal' }] }] }, data: { secretName: 'Bearer abc.def', token: 'literal' } }
    expect(sanitizeKubernetes(pod)).toEqual({ spec: { volumes: [{ name: 'db', secret: { secretName: 'db-credentials', items: [{ key: 'password', path: 'pw' }] } }], containers: [{ name: 'app', env: [{ name: 'API_TOKEN', value: '[redacted]' }] }] }, data: { secretName: '[redacted]', token: '[redacted]' } })
  })
})

describe('eviction, status patches and capabilities', () => {
  it('evicts through the Eviction API with the pod UID as a precondition, and reports a PodDisruptionBudget refusal as throttled', async () => {
    let received: unknown
    nock('http://127.0.0.1:18445').post('/api/v1/namespaces/shop/pods/api-0/eviction', body => { received = body; return true }).query({ dryRun: 'All' }).reply(201, { kind: 'Status', status: 'Success' })
    const evict = { operation: 'evict' as const, ref: { resource: 'pods' as const, namespace: 'shop', name: 'api-0' }, uid: 'pod-uid' }
    expect((await client('write').run({ mode: 'write', mutation: evict, dryRun: true })).error).toBeNull()
    expect(received).toEqual({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: 'api-0', namespace: 'shop' }, deleteOptions: { preconditions: { uid: 'pod-uid' } } })
    nock('http://127.0.0.1:18445').post('/api/v1/namespaces/shop/pods/api-0/eviction').reply(429, { message: 'Cannot evict pod as it would violate the pod\'s disruption budget.' })
    expect((await client('write').run({ mode: 'write', mutation: evict, dryRun: false })).error).toBe('throttled')
    expect(() => assertConnectorScope({ mode: 'write', mutation: evict, dryRun: false }, scope, 'read')).toThrow('read connector')
  })

  it('patches the status subresource of a custom resource, with the same preconditions', async () => {
    let received: unknown
    const api = nock('http://127.0.0.1:18445').patch('/apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/web/status', body => { received = body; return true }).reply(200, { metadata: { uid: 'r-1', resourceVersion: '8' } })
    const result = await client('write').run({ mode: 'write', dryRun: false, mutation: { operation: 'patch', subresource: 'status', ref: { resource: 'rollouts', namespace: 'shop', name: 'web' }, uid: 'r-1', resourceVersion: '7', patch: [{ op: 'add', path: '/status/abort', value: true }] } })
    expect(result.error).toBeNull()
    expect(received).toEqual([{ op: 'test', path: '/metadata/uid', value: 'r-1' }, { op: 'test', path: '/metadata/resourceVersion', value: '7' }, { op: 'add', path: '/status/abort', value: true }])
    expect(api.isDone()).toBe(true)
  })

  const discovery = (argo: number, kustomize: number, helm: number) => nock('http://127.0.0.1:18445')
    .get('/apis/argoproj.io/v1alpha1').twice().reply(argo, { resources: [{ name: 'applications' }, { name: 'applications/status' }] })
    .get('/apis/kustomize.toolkit.fluxcd.io/v1').reply(kustomize)
    .get('/apis/helm.toolkit.fluxcd.io/v2').reply(helm, { resources: [{ name: 'helmreleases' }] })

  it('reports only the custom resources the cluster serves, and eviction and status patches only on a writer', async () => {
    discovery(200, 404, 200)
    const heartbeat = await client('write').capabilities()
    expect(heartbeat).toEqual({ version: '0.2.0', features: ['eviction', 'status_patch', 'applications', 'helmreleases'] })
    expect(connectorHeartbeatSchema.parse(heartbeat)).toEqual(heartbeat)
    discovery(200, 404, 200)
    expect((await client('read').capabilities()).features).toEqual(['applications', 'helmreleases'])
  })

  it('keeps the last answer when discovery fails, and drops a custom resource only on a 404', async () => {
    const reader = client('read')
    discovery(200, 404, 200)
    expect((await reader.capabilities()).features).toEqual(['applications', 'helmreleases'])
    discovery(503, 503, 404)
    expect((await reader.capabilities()).features).toEqual(['applications'])
  })

  it('halves a list page over the byte limit and returns the continue token', async () => {
    const big = 'x'.repeat(30_000)
    const api = nock('http://127.0.0.1:18445')
    const page = (limit: number) => api.get('/apis/argoproj.io/v1alpha1/namespaces/shop/applications').query({ limit: String(limit) })
    page(100).reply(200, { items: Array.from({ length: 100 }, () => ({ big })) })
    page(50).reply(200, { items: Array.from({ length: 50 }, () => ({ big: 'small' })), metadata: { continue: 'next' } })
    const result = await client().run({ mode: 'read', query: { operation: 'list', resource: 'applications', namespace: 'shop', limit: 100 } })
    expect(result).toMatchObject({ error: null, truncated: true, data: { continueToken: 'next' } })
    expect((result.data as { items: unknown[] }).items).toHaveLength(50)
  })

  it('reports an object over the byte limit as unavailable, not invalid', async () => {
    nock('http://127.0.0.1:18445').get('/api/v1/namespaces/shop/configmaps/huge').reply(200, { big: 'x'.repeat(2_100_000) })
    expect((await client().run({ mode: 'read', query: { operation: 'get', ref: { resource: 'configmaps', namespace: 'shop', name: 'huge' } } })).error).toBe('unavailable')
  })

  it('keeps only the shape of Helm values, Flux substitutions and inline patches', () => {
    expect(sanitizeKubernetes({ kind: 'HelmRelease', spec: { values: { api_key: 'plain', db: { pass: 'hunter2', replicas: 2 }, hosts: ['a'] } } }))
      .toEqual({ kind: 'HelmRelease', spec: { values: { api_key: '[redacted]', db: { pass: '[redacted]', replicas: '[redacted]' }, hosts: ['[redacted]'] } } })
    expect(sanitizeKubernetes({ kind: 'Kustomization', spec: { postBuild: { substitute: { STRIPE_KEY: 'plain' } }, patches: [{ patch: 'value: plain', target: { kind: 'Deployment' } }] } }))
      .toEqual({ kind: 'Kustomization', spec: { postBuild: { substitute: { STRIPE_KEY: '[redacted]' } }, patches: [{ patch: '[redacted]', target: { kind: 'Deployment' } }] } })
    expect(sanitizeKubernetes({ spec: { source: { helm: { values: 'db:\n  pass: hunter2\n', valuesObject: { apiKey: 'plain' } }, plugin: { parameters: [{ name: 'a', string: 'plain' }, { name: 'b', map: { c: 'plain' } }] } } } }))
      .toEqual({ spec: { source: { helm: { values: '[redacted]', valuesObject: { apiKey: '[redacted]' } }, plugin: { parameters: [{ name: 'a', string: '[redacted]' }, { name: 'b', map: '[redacted]' }] } } } })
  })

  it('redacts credentials under common key names, and leaves selector values and lookalike keys alone', () => {
    expect(sanitizeKubernetes({ api_key: 'a', smtpPwd: 'b', DB_PASS: 'c', dbPass: 'd', dsn: 'e', accessKeyId: 'f', bypass: 'kept', matchExpressions: [{ key: 'tier', operator: 'In', values: ['web'] }] }))
      .toEqual({ api_key: '[redacted]', smtpPwd: '[redacted]', DB_PASS: '[redacted]', dbPass: '[redacted]', dsn: '[redacted]', accessKeyId: '[redacted]', bypass: 'kept', matchExpressions: [{ key: 'tier', operator: 'In', values: ['web'] }] })
  })

  it('keeps the name in a reference with kind Secret, and still reduces a Secret to its key names', () => {
    expect(sanitizeKubernetes({ status: { resources: [{ kind: 'Secret', namespace: 'shop', name: 'web-tls', status: 'OutOfSync' }] }, spec: { valuesFrom: [{ kind: 'Secret', name: 'prod-values', valuesKey: 'values.yaml' }] } }))
      .toEqual({ status: { resources: [{ kind: 'Secret', namespace: 'shop', name: 'web-tls', status: 'OutOfSync' }] }, spec: { valuesFrom: [{ kind: 'Secret', name: 'prod-values', valuesKey: 'values.yaml' }] } })
    expect(sanitizeKubernetes({ kind: 'Secret', data: { password: 'aHVudGVyMg==' } })).toEqual({ kind: 'Secret', keys: ['password'] })
    expect(sanitizeKubernetes({ kind: 'SecretList', items: [{ metadata: { name: 'db' }, data: { password: 'aHVudGVyMg==' } }] })).toEqual({ kind: 'SecretList', items: [{ kind: 'Secret', metadata: { name: 'db' }, keys: ['password'] }] })
  })

  it('retains GitOps ownership and rollout revision annotations, and still drops the rest', () => {
    expect(sanitizeKubernetes({ metadata: { annotations: { 'argocd.argoproj.io/tracking-id': 'shop:apps/Deployment:shop/web', 'rollout.argoproj.io/revision': '4', 'example.com/note': 'dropped' } } }))
      .toEqual({ metadata: { annotations: { 'argocd.argoproj.io/tracking-id': 'shop:apps/Deployment:shop/web', 'rollout.argoproj.io/revision': '4' } } })
  })

  it('reports the version the package and chart are released as', async () => {
    const { readFileSync } = await import('node:fs')
    expect(connectorVersion).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    expect(readFileSync(new URL('../chart/ace-kubernetes-connector/Chart.yaml', import.meta.url), 'utf8')).toContain(`version: ${connectorVersion}`)
  })
})

describe('reads keep the evidence an incident turns on', () => {
  it('returns the newest log lines, a Secret\'s key names through a second pass, and an unanswered API call as unavailable', async () => {
    // A worker that logs long routine lines, a credential, and then fails on its last line: more than any byte bound.
    const lines = Array.from({ length: 299 }, (_, i) => `2026-11-04T10:${String(i % 60).padStart(2, '0')}:00Z INFO invoice-worker heartbeat queue=invoices lag=${i} ${'.'.repeat(400)}`)
    lines.splice(290, 0, '2026-11-04T10:58:00Z DEBUG connecting with password=hunter2')
    lines.push('2026-11-04T10:59:59Z FATAL invoice-worker: payment gateway rejected TLS handshake: certificate expired')
    // As the API server answers: limitBytes keeps the first bytes of the tail.
    nock('http://127.0.0.1:18445').get('/api/v1/namespaces/shop/pods/worker/log').query(true).reply(function (uri) {
      const limit = Number(new URL(uri, 'http://x').searchParams.get('limitBytes') ?? Infinity)
      return [200, Buffer.from(lines.join('\n')).subarray(0, limit).toString()]
    })
    const log = await client().run({ mode: 'read', query: { operation: 'logs', namespace: 'shop', pod: 'worker', container: 'app', previous: false, sinceTime: '2026-11-04T10:00:00Z', tailLines: 300 } })
    const text = log.data as string
    expect(text.split('\n').at(-1)).toContain('FATAL invoice-worker')
    expect(text).toMatch(/^\[\d+ earlier log lines omitted\]\n/)
    expect(text).not.toContain('hunter2')
    expect(log.truncated).toBe(true)
    // A pathological body costs bounded time, and its end survives.
    const started = Date.now(), huge = sanitizeLogText(`${'a.'.repeat(1_000_000)}\nlast line`)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(huge.endsWith('last line')).toBe(true)
    // A private key cut by the bound is removed, not left without its BEGIN marker.
    const key = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n'.repeat(700)}-----END PRIVATE KEY-----\nready`
    expect(sanitizeLogText(key)).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC')
    // Short logs are returned whole, unchanged.
    nock('http://127.0.0.1:18445').get('/api/v1/namespaces/shop/pods/quiet/log').query(true).reply(200, 'started\nready')
    expect((await client().run({ mode: 'read', query: { operation: 'logs', namespace: 'shop', pod: 'quiet', container: 'app', previous: false, sinceTime: '2026-11-04T10:00:00Z', tailLines: 10 } })).data).toBe('started\nready')

    // Ace sanitizes the connector's result again; a renewed certificate Secret must still show its keys, and an empty one none.
    const tls = sanitizeKubernetes({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', metadata: { name: 'billing-tls' }, data: { 'tls.crt': 'Y2VydA==', 'tls.key': 'a2V5' } })
    expect((sanitizeKubernetes(JSON.parse(JSON.stringify(tls))) as { keys: string[] }).keys).toEqual(['tls.crt', 'tls.key'])
    expect((sanitizeKubernetes(sanitizeKubernetes({ kind: 'Secret', metadata: { name: 'empty' }, data: {} })) as { keys: string[] }).keys).toEqual([])
    // Metadata alone says nothing about keys: none are claimed.
    expect(sanitizeKubernetes({ kind: 'Secret', metadata: { name: 'db' } })).not.toHaveProperty('keys')

    // An API server that drops the connection did not reject the query: the read is unavailable, not invalid.
    const server = createServer((request) => request.socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const kube = new KubeConfig()
    kube.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' })
    nock.enableNetConnect('127.0.0.1')
    try { expect((await new KubernetesConnectorClient(kube, scope, 'read').run({ mode: 'read', query: { operation: 'get', ref: { resource: 'endpoints', namespace: 'shop', name: 'post-storage' } } })).error).toBe('unavailable') }
    finally { await new Promise(resolve => server.close(resolve)) }
  })

  it('lets equal literal environment values be told from changed ones without disclosing either', () => {
    const container = (env: Array<{ name: string; value: unknown }>) => sanitizeKubernetesResult({ spec: { template: { spec: { containers: [{ name: 'api', env }] } } } }, { fingerprints: true }) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }
    const values = (env: Array<{ name: string; value: unknown }>) => container(env).spec.template.spec.containers[0].env.map(item => item.value)
    const before = values([{ name: 'PAYMENTS_API_URL', value: 'https://payments.internal' }, { name: 'LOG_LEVEL', value: 'info' }])
    const after = values([{ name: 'PAYMENTS_API_URL', value: 'https://payments.staging.internal' }, { name: 'LOG_LEVEL', value: 'info' }])
    expect([...before, ...after].every(value => literalFingerprint.test(value))).toBe(true)
    expect(after[0]).not.toBe(before[0])
    // An unchanged value keeps its fingerprint, so nothing is reported as changed when nothing did.
    expect(after[1]).toBe(before[1])
    // A name defined twice: whether the two definitions differ is visible.
    const shadowed = values([{ name: 'UPSTREAM_HOST', value: 'cart:8080' }, { name: 'UPSTREAM_HOST', value: 'cart-canary:8080' }])
    expect(shadowed[0]).not.toBe(shadowed[1])
    // A value copied from a fingerprint is still a different value, and key order alone is not a change.
    expect(values([{ name: 'LOG_LEVEL', value: before[1] }])[0]).not.toBe(before[1])
    expect(values([{ name: 'LIMITS', value: { a: 1, b: 2 } }])).toEqual(values([{ name: 'LIMITS', value: { b: 2, a: 1 } }]))
    // No value ever leaves, and without fingerprinting (a writer) literals are only redacted.
    expect(JSON.stringify([before, after, shadowed])).not.toMatch(/payments|cart|info/)
    expect(sanitizeKubernetes({ env: [{ name: 'LOG_LEVEL', value: 'info' }] })).toEqual({ env: [{ name: 'LOG_LEVEL', value: '[redacted]' }] })
  })
})
