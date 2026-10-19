import { runConnectorWorker } from './worker'
import { setTimeout as pause } from 'node:timers/promises'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { KubeConfig } from '@kubernetes/client-node'
import { z } from 'zod'
import { KubernetesConnectorClient } from './client'
import { connectorScopeSchema, kubernetesCommandSchema } from './protocol'

const leaseSchema = z.object({ id: z.string().uuid(), leaseId: z.string().uuid(), expiresAt: z.string().datetime(), command: kubernetesCommandSchema })
async function main() {
  const api = new URL(process.env.ACE_API_URL ?? '')
  if (api.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) throw new Error('The Ace endpoint must use HTTPS, except on loopback.')
  if (api.username || api.password || api.search || api.hash) throw new Error('Invalid Ace endpoint.')
  const id = z.string().uuid().parse(process.env.ACE_CONNECTOR_ID)
  const mode = z.enum(['read', 'write']).parse(process.env.ACE_CONNECTOR_MODE ?? 'read')
  const scope = connectorScopeSchema.parse({ clusterName: process.env.ACE_CLUSTER_NAME, namespaces: (process.env.ACE_NAMESPACES ?? '').split(',').filter(Boolean), clusterResources: process.env.ACE_CLUSTER_RESOURCES === 'true' })
  const kube = new KubeConfig()
  if (process.env.KUBECONFIG) kube.loadFromFile(process.env.KUBECONFIG)
  else kube.loadFromCluster()
  const client = new KubernetesConnectorClient(kube, scope, mode)
  const endpoint = new URL(`/api/connectors/kubernetes/${mode}/${id}`, api)
  const token = async () => process.env.ACE_CONNECTOR_TOKEN_FILE ? (await readFile(process.env.ACE_CONNECTOR_TOKEN_FILE, 'utf8')).trim() : z.string().min(32).parse(process.env.ACE_CONNECTOR_TOKEN)
  const shutdown = new AbortController()
  const send = async (body: unknown, timeout = 20_000) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]) })
    if (!response.ok) throw new Error(`Ace connector endpoint returned ${response.status}`)
    return await response.json() as { data?: unknown }
  }
  process.once('SIGTERM', () => shutdown.abort())
  process.once('SIGINT', () => shutdown.abort())
  let connectedAt = 0, healthy = true
  let healthUpdate = Promise.resolve()
  const worker = runConnectorWorker({
    signal: shutdown.signal,
    poll: async () => { const response = await send({ operation: 'poll' }); return response.data ? leaseSchema.parse(response.data) : null },
    execute: command => client.run(command),
    complete: async (lease, result) => { await send({ operation: 'complete', id: lease.id, leaseId: lease.leaseId, result }) },
    health: connected => {
      healthUpdate = healthUpdate.then(async () => {
      if (connected) connectedAt = Date.now()
      if (!connected && healthy) process.stderr.write('Connector request failed; check connection status in Ace.\n')
      healthy = connected
      await writeFile('/tmp/ace-connector-health.pending', JSON.stringify({ attemptedAt: Date.now(), connectedAt }), { mode: 0o600 })
      await rename('/tmp/ace-connector-health.pending', '/tmp/ace-connector-health.json')
      })
      return healthUpdate
    },
  })
  let validation: Promise<void> = Promise.resolve()
  if (mode === 'read') {
    validation = (async () => {
      while (!shutdown.signal.aborted) {
        try { await send({ operation: 'validate' }, 300_000) } catch { process.stderr.write('Cluster validation is incomplete.\n') }
        await pause(600_000, undefined, { signal: shutdown.signal }).catch(() => {})
      }
    })()
  }
  try { await Promise.all([worker, validation]) }
  finally { shutdown.abort(); await Promise.allSettled([worker, validation]) }
}
void main().catch(() => { process.stderr.write('Kubernetes connector stopped; check configuration and connection status in Ace.\n'); process.exitCode = 1 })
