import { describe, it, expect } from 'vitest'
import nock from 'nock'
import { KubeConfig } from '@kubernetes/client-node'
import { KubernetesConnectorClient } from '../src/client'
import { assertConnectorScope, kubernetesMutationSchema } from '../src/protocol'
import { sanitizeKubernetes } from '../src/sanitize'

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
