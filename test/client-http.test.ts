import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { KubeConfig } from '@kubernetes/client-node'
import { KubernetesConnectorClient } from '../src/client'

// A real HTTP server, not an interceptor: request framing decides whether the
// API server receives DeleteOptions at all.
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })
const body = (request: IncomingMessage) => new Promise<string>(resolve => { let text = ''; request.on('data', chunk => { text += chunk }); request.on('end', () => resolve(text)) })

it('delivers delete preconditions so a replaced object is never deleted', async () => {
  const received: unknown[] = []
  const server = createServer(async (request, response) => {
    const text = await body(request)
    const options = text ? JSON.parse(text) : null
    received.push(options)
    // Mirrors the API server: absent DeleteOptions means an unconditional delete.
    const conflict = options?.preconditions && options.preconditions.uid !== 'current-uid'
    response.writeHead(conflict ? 409 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(conflict ? { kind: 'Status', status: 'Failure' } : { kind: 'Status', status: 'Success' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const kube = new KubeConfig()
  kube.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' })
  const client = new KubernetesConnectorClient(kube, { clusterName: 'test', namespaces: ['shop'], clusterResources: false }, 'write')
  const result = await client.run({ mode: 'write', dryRun: false, mutation: { operation: 'delete', ref: { resource: 'configmaps', namespace: 'shop', name: 'settings' }, uid: 'replaced-uid', resourceVersion: '7' } })
  expect(received).toEqual([{ apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid: 'replaced-uid', resourceVersion: '7' } }])
  expect(result.error).toBe('conflict')
})

it('does not delete anything on a dry run', async () => {
  const deleted: string[] = []
  const server = createServer(async (request, response) => {
    const text = await body(request)
    // Mirrors the API server: a DELETE with a body takes its options only from that body, so a dryRun query is ignored.
    const dryRun = text ? JSON.parse(text).dryRun?.includes('All') : new URL(request.url!, 'http://api').searchParams.get('dryRun') === 'All'
    if (!dryRun) deleted.push(request.url!)
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ kind: 'Status', status: 'Success' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const kube = new KubeConfig()
  kube.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' })
  const client = new KubernetesConnectorClient(kube, { clusterName: 'test', namespaces: ['shop'], clusterResources: false }, 'write')
  const mutation = { operation: 'delete' as const, ref: { resource: 'configmaps' as const, namespace: 'shop', name: 'settings' }, uid: 'current-uid', resourceVersion: '7' }
  expect((await client.run({ mode: 'write', dryRun: true, mutation })).error).toBeNull()
  expect(deleted).toEqual([])
  expect((await client.run({ mode: 'write', dryRun: false, mutation })).error).toBeNull()
  expect(deleted).toHaveLength(1)
})

/** A real server standing in for the API server: answers from `objects` by path and records every write. */
async function apiServer(objects: Record<string, unknown>) {
  const writes: Array<{ method: string; url: string; body: any }> = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = createServer(async (request, response) => {
    const text = await body(request), path = request.url!.split('?')[0]!
    const json = (status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    if (request.method === 'GET') return objects[path] ? json(200, objects[path]) : json(404, { kind: 'Status' })
    writes.push({ method: request.method!, url: request.url!, body: text ? JSON.parse(text) : null })
    return json(200, { kind: 'Status', status: 'Success' })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const kube = new KubeConfig()
  kube.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' })
  return { writes, client: new KubernetesConnectorClient(kube, { clusterName: 'test', namespaces: ['shop'], clusterResources: false }, 'write') }
}
const deploymentRef = { resource: 'deployments' as const, namespace: 'shop', name: 'api' }
const deploymentPath = '/apis/apps/v1/namespaces/shop/deployments/api'

it('pins a spec change to its generation, so status updates during an incident do not void an approved plan', async () => {
  const { client, writes } = await apiServer({})
  const patch = [{ op: 'replace' as const, path: '/spec/replicas', value: 3 }]
  await client.run({ mode: 'write', dryRun: false, mutation: { operation: 'patch', ref: deploymentRef, uid: 'api-uid', resourceVersion: '7', generation: 2, patch } })
  await client.run({ mode: 'write', dryRun: false, mutation: { operation: 'patch', ref: deploymentRef, uid: 'api-uid', resourceVersion: '7', patch } })
  expect(writes[0]!.body).toEqual([{ op: 'test', path: '/metadata/uid', value: 'api-uid' }, { op: 'test', path: '/metadata/generation', value: 2 }, ...patch])
  expect(writes[1]!.body).toEqual([{ op: 'test', path: '/metadata/uid', value: 'api-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: '7' }, ...patch])
})

it('refuses a delete once the spec has changed, and deletes a pod by its identity alone', async () => {
  const { client, writes } = await apiServer({ [deploymentPath]: { metadata: { uid: 'api-uid', resourceVersion: '9', generation: 3 } } })
  const mutation = { operation: 'delete' as const, ref: deploymentRef, uid: 'api-uid', resourceVersion: '7' }
  expect((await client.run({ mode: 'write', dryRun: false, mutation: { ...mutation, generation: 2 } })).error).toBe('conflict')
  expect(writes).toEqual([])
  expect((await client.run({ mode: 'write', dryRun: false, mutation: { ...mutation, generation: 3 } })).error).toBeNull()
  expect(writes[0]!.body.preconditions).toEqual({ uid: 'api-uid', resourceVersion: '9' })
  await client.run({ mode: 'write', dryRun: false, mutation: { operation: 'delete', ref: { resource: 'pods', namespace: 'shop', name: 'api-1' }, uid: 'pod-uid', resourceVersion: '4' } })
  expect(writes[1]!.body.preconditions).toEqual({ uid: 'pod-uid' })
})

it('restores a revision the workload owns, with its real values and without the controller hash, and no other', async () => {
  const template = { metadata: { labels: { app: 'api', 'pod-template-hash': 'abc' } }, spec: { containers: [{ name: 'api', env: [{ name: 'TOKEN', value: 'real-value' }] }] } }
  const replicaSet = (uid: string, owner: string) => ({ metadata: { uid, ownerReferences: [{ uid: owner }] }, spec: { template } })
  const { client, writes } = await apiServer({ '/apis/apps/v1/namespaces/shop/replicasets/api-1': replicaSet('rs-uid', 'api-uid'), '/apis/apps/v1/namespaces/shop/replicasets/other': replicaSet('other-uid', 'other-owner') })
  const mutation = { operation: 'restore_revision' as const, ref: deploymentRef, uid: 'api-uid', resourceVersion: '7', generation: 2 }
  const source = (name: string, uid: string) => ({ resource: 'replicasets' as const, name, uid })
  expect((await client.run({ mode: 'write', dryRun: false, mutation: { ...mutation, source: source('other', 'other-uid') } })).error).toBe('conflict')
  expect((await client.run({ mode: 'write', dryRun: false, mutation: { ...mutation, source: source('api-1', 'replaced-uid') } })).error).toBe('conflict')
  expect(writes).toEqual([])
  expect((await client.run({ mode: 'write', dryRun: true, mutation: { ...mutation, source: source('api-1', 'rs-uid') } })).error).toBeNull()
  expect(writes[0]!.url).toContain('dryRun=All')
  expect(writes[0]!.body).toEqual([{ op: 'test', path: '/metadata/uid', value: 'api-uid' }, { op: 'test', path: '/metadata/generation', value: 2 },
    { op: 'replace', path: '/spec/template', value: { metadata: { labels: { app: 'api' } }, spec: template.spec } }])
})
