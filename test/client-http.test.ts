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
