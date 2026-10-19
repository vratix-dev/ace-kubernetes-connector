import { setTimeout as pause } from 'node:timers/promises'
import type { KubernetesCommand, ConnectorResult } from './protocol'
export type ConnectorLease = { id: string; leaseId: string; expiresAt: string; command: KubernetesCommand }
/** One idle poller, up to four active requests. Backoff never replays a lease. */
export async function runConnectorWorker(io: {
  signal: AbortSignal; poll: () => Promise<ConnectorLease | null>; execute: (command: KubernetesCommand) => Promise<ConnectorResult>;
  complete: (lease: ConnectorLease, result: ConnectorResult) => Promise<void>; health: (connected: boolean) => Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const active = new Set<Promise<void>>()
  const wait = io.wait ?? ((ms, signal) => pause(ms, undefined, { signal }))
  let idle = 0
  try {
    while (!io.signal.aborted) {
      if (active.size >= 4) { await Promise.race(active); continue }
      try {
        const lease = await io.poll()
        await io.health(true)
        if (lease) {
          idle = 0
          const work = (async () => {
            // Too little time remains to finish; report it unexecuted rather than leave the caller waiting.
            const result = Date.parse(lease.expiresAt) <= Date.now() + 16_000
              ? { observedAt: new Date().toISOString(), data: null, truncated: false, error: 'unavailable' as const }
              : await io.execute(lease.command)
            await io.complete(lease, result)
          })().catch(async () => { if (!io.signal.aborted) await io.health(false) }).finally(() => active.delete(work))
          active.add(work)
          continue
        }
      } catch { if (!io.signal.aborted) await io.health(false) }
      await wait(Math.min(8000, 1000 * 2 ** Math.min(idle++, 3)), io.signal)
    }
  } catch(error) { if (!io.signal.aborted) throw error }
  finally { await Promise.allSettled(active) }
}
