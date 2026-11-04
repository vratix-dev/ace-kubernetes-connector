import https from 'node:https'
import http from 'node:http'
import { Writable } from 'node:stream'
import { Exec, KubeConfig } from '@kubernetes/client-node'
import { assertConnectorScope, customResources, kubernetesResources, resourcePath, type ConnectorHeartbeat, type ConnectorResult, type ConnectorScope, type CustomResource, type KubernetesCommand } from './protocol'
import { LOG_READ_BYTES, sanitizeKubernetesResult, kubernetesPayloadTruncated } from './sanitize'

type PodTemplate = { metadata?: { labels?: Record<string, string> }; $patch?: unknown }

class ApiFailure extends Error {
  constructor(readonly status: number) { super(`Kubernetes API returned ${status}.`) }
}

/** The API server never answered: a timeout, a refused or reset connection. It says nothing about the request itself. */
class TransportFailure extends Error {}

class ResponseTooLarge extends Error {
  constructor() { super('Kubernetes response exceeded the byte limit.') }
}

/** The release this connector reports in its heartbeat; the release workflow checks it against package.json and the chart. */
export const connectorVersion = '0.2.0'

/** Executes scoped commands against the local Kubernetes API. */
export class KubernetesConnectorClient {
  private readonly served = new Set<CustomResource>()

  constructor(private readonly kube: KubeConfig, readonly scope: ConnectorScope, readonly mode: 'read' | 'write') {}

  /**
   * One API call. `tailBytes` reads text and keeps only its last bytes, from the next whole line on: a pod log's
   * newest lines are the ones that matter, and the API server's own limitBytes would keep the oldest instead.
   */
  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, tailBytes?: number): Promise<unknown> {
    const cluster = this.kube.getCurrentCluster()
    if (!cluster) throw new Error('Kubernetes context is missing.')
    const destination = new URL(path, cluster.server)
    if (destination.origin !== new URL(cluster.server).origin) throw new Error('Invalid API destination.')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    // Node does not frame DELETE bodies by default; without a length the API
    // server ignores DeleteOptions, silently dropping UID/version preconditions.
    const options: https.RequestOptions = { method, headers: { Accept: 'application/json', ...headers, ...(payload === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(payload)) }) } }
    await this.kube.applyToHTTPSOptions(options)
    return new Promise((resolve, reject) => {
      const transport = destination.protocol === 'https:' ? https : http
      const request = transport.request(destination, options, response => {
        const chunks: Buffer[] = []; let bytes = 0, held = 0, cut = false
        response.on('data', chunk => {
          bytes += chunk.length
          if (tailBytes) {
            chunks.push(Buffer.from(chunk)); held += chunk.length
            while (chunks.length > 1 && held - chunks[0].length >= tailBytes) { held -= chunks.shift()!.length; cut = true }
            return
          }
          if (bytes > 2_000_000) { response.destroy(); reject(new ResponseTooLarge()); return }
          chunks.push(Buffer.from(chunk))
        })
        response.on('error', error => reject(new TransportFailure(error.message)))
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) { reject(new ApiFailure(response.statusCode ?? 500)); return }
          if (tailBytes) {
            let all = Buffer.concat(chunks)
            if (all.length > tailBytes) { all = all.subarray(all.length - tailBytes); cut = true }
            const text = all.toString('utf8')
            // A cut starts mid-line, possibly mid-character: the text starts at the next whole line.
            resolve({ text: cut && text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text, cut })
            return
          }
          const text = Buffer.concat(chunks).toString('utf8')
          try { resolve(JSON.parse(text)) } catch { resolve(text) }
        })
      })
      const deadline = setTimeout(() => request.destroy(new TransportFailure('Kubernetes request timed out.')), 15_000)
      request.on('close', () => clearTimeout(deadline))
      request.on('error', error => reject(error instanceof TransportFailure ? error : new TransportFailure(error.message)))
      request.end(payload)
    })
  }

  private async execute(command: Extract<KubernetesCommand, { mode: 'write' }>): Promise<unknown> {
    const mutation = command.mutation
    const path = resourcePath(mutation.ref)
    const suffix = command.dryRun ? '?dryRun=All' : ''
    // Status updates move resourceVersion constantly during an incident; generation moves only when the spec does.
    const pin = (target: { resourceVersion: string; generation?: number }) => target.generation === undefined
      ? { op: 'test', path: '/metadata/resourceVersion', value: target.resourceVersion }
      : { op: 'test', path: '/metadata/generation', value: target.generation }
    if (mutation.operation === 'patch') {
      return this.request(path + (mutation.subresource ? `/${mutation.subresource}` : '') + suffix, 'PATCH', [
        { op: 'test', path: '/metadata/uid', value: mutation.uid },
        pin(mutation),
        ...mutation.patch,
      ], { 'Content-Type': 'application/json-patch+json' })
    }
    // The API server reads a DELETE's options only from its body when it has one, ignoring a dryRun query.
    if (mutation.operation === 'delete') {
      // A pod's status changes constantly and its UID is its identity; anything else keeps a version precondition.
      let resourceVersion: string | undefined = mutation.ref.resource === 'pods' ? undefined : mutation.resourceVersion
      if (mutation.generation !== undefined && mutation.ref.resource !== 'pods') {
        const current = await this.request(path) as { metadata: { uid: string; resourceVersion: string; generation?: number } }
        if (current.metadata.uid !== mutation.uid || current.metadata.generation !== mutation.generation) throw new ApiFailure(409)
        resourceVersion = current.metadata.resourceVersion
      }
      return this.request(path, 'DELETE', {
        apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', ...(command.dryRun ? { dryRun: ['All'] } : {}),
        preconditions: { uid: mutation.uid, ...(resourceVersion ? { resourceVersion } : {}) },
      }, { 'Content-Type': 'application/json' })
    }
    if (mutation.operation === 'restore_revision') {
      const source = await this.request(resourcePath({ resource: mutation.source.resource, namespace: mutation.ref.namespace, name: mutation.source.name })) as {
        metadata: { uid: string; ownerReferences?: Array<{ uid: string }> }; spec?: { template?: PodTemplate }; data?: { spec?: { template?: PodTemplate } }
      }
      // A revision is restored only into the workload that owns it.
      if (source.metadata.uid !== mutation.source.uid || !source.metadata.ownerReferences?.some(owner => owner.uid === mutation.uid)) throw new ApiFailure(409)
      const template = structuredClone(mutation.source.resource === 'replicasets' ? source.spec?.template : source.data?.spec?.template)
      if (!template) throw new ApiFailure(422)
      // The controller adds its hash label to each ReplicaSet's copy; kubectl rollout undo removes it too.
      delete template.metadata?.labels?.[mutation.ref.resource === 'rollouts' ? 'rollouts-pod-template-hash' : 'pod-template-hash']
      delete template.$patch
      return this.request(path + suffix, 'PATCH', [
        { op: 'test', path: '/metadata/uid', value: mutation.uid },
        pin(mutation),
        { op: 'replace', path: '/spec/template', value: template },
      ], { 'Content-Type': 'application/json-patch+json' })
    }
    if (mutation.operation === 'evict') return this.request(`${path}/eviction${suffix}`, 'POST', {
      apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: mutation.ref.name, namespace: mutation.ref.namespace },
      deleteOptions: { preconditions: { uid: mutation.uid } },
    }, { 'Content-Type': 'application/json' })
    if (mutation.operation === 'create') {
      const metadata = mutation.manifest.metadata as { name?: string; namespace?: string } | undefined
      if (metadata?.name !== mutation.ref.name || (metadata.namespace ?? null) !== mutation.ref.namespace || mutation.manifest.apiVersion !== kubernetesResources[mutation.ref.resource].api) throw new Error('Manifest identity must match the approved resource.')
      return this.request(resourcePath({ ...mutation.ref, name: undefined }) + suffix, 'POST', mutation.manifest, { 'Content-Type': 'application/json' })
    }
    if (command.dryRun) throw new Error('Container commands do not support dry-run.')
    const pod = await this.request(path) as { metadata?: { uid?: string } }
    if (pod.metadata?.uid !== mutation.uid) throw new ApiFailure(409)
    return new Promise((resolve, reject) => {
      let output = ''; let finished = false; let timedOut = false
      const sink = new Writable({ write(chunk, _encoding, callback) { output = (output + chunk.toString()).slice(0, 32_000); callback() } })
      const timer = setTimeout(() => { timedOut = true; socket?.close(); reject(new Error('Container command outcome is unknown.')) }, 15_000)
      let socket: Awaited<ReturnType<Exec['exec']>> | undefined
      void new Exec(this.kube).exec(mutation.ref.namespace, mutation.ref.name, mutation.container, mutation.argv, sink, sink, null, false, status => {
        finished = true; clearTimeout(timer); resolve({ status, output })
      }).then(value => {
        socket = value
        if (timedOut) { value.close(); return }
        value.on('error', () => { clearTimeout(timer); reject(new Error('Container command outcome is unknown.')) })
        value.on('close', () => { clearTimeout(timer); if (!finished) reject(new Error('Container command outcome is unknown.')) })
      }, () => { clearTimeout(timer); reject(new Error('Container command outcome is unknown.')) })
    })
  }

  /**
   * The heartbeat's capabilities: eviction and status patches on a writer, and each allowlisted custom resource whose
   * API group version the cluster serves. Only a 404 or a missing resource means not served; any other failure says
   * nothing about the cluster, so the last answer stands. API discovery needs no RBAC grant beyond the default
   * system:discovery role.
   */
  async capabilities(): Promise<ConnectorHeartbeat> {
    await Promise.all(customResources.map(async resource => {
      try {
        const list = await this.request(`/apis/${kubernetesResources[resource].api}`) as { resources?: Array<{ name?: string }> }
        if (list.resources?.some(item => item.name === resource)) this.served.add(resource)
        else this.served.delete(resource)
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 404) this.served.delete(resource)
      }
    }))
    return { version: connectorVersion, features: [...(this.mode === 'write' ? ['eviction', 'status_patch'] as const : []), ...(this.mode === 'read' && this.scope.allNamespaces ? ['all_namespaces'] as const : []), ...customResources.filter(resource => this.served.has(resource))] }
  }

  /** One page of a list. A page over the byte limit is retried at half the size; the continue token reaches the rest. */
  private async listPage(query: Extract<Extract<KubernetesCommand, { mode: 'read' }>['query'], { operation: 'list' }>, limit: number): Promise<unknown> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (query.continueToken) params.set('continue', query.continueToken)
    if (query.selector) params.set('labelSelector', query.selector)
    try {
      return await this.request(`${resourcePath(query)}?${params}`, 'GET', undefined, query.resource === 'secrets' ? { Accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' } : {})
    } catch (error) {
      if (error instanceof ResponseTooLarge && limit > 1) return this.listPage(query, Math.ceil(limit / 2))
      throw error
    }
  }

  async run(command: KubernetesCommand): Promise<ConnectorResult> {
    let mutationStarted = false
    try {
      assertConnectorScope(command, this.scope, this.mode)
      let data: unknown; let truncated = false
      if (command.mode === 'write') {
        mutationStarted = !command.dryRun
        data = await this.execute(command)
      } else {
        const query = command.query
        switch (query.operation) {
          case 'identity': {
            const namespace = await this.request('/api/v1/namespaces/kube-system') as { metadata: { uid: string } }
            data = { clusterUid: namespace.metadata.uid, version: await this.request('/version') }
            break
          }
          case 'access': {
            const spec = kubernetesResources[query.resource]
            data = await this.request('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', 'POST', {
              apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: {
                group: spec.api === 'v1' ? '' : spec.api.split('/')[0], resource: query.resource, subresource: query.subresource, verb: query.verb, namespace: query.namespace ?? undefined,
              } },
            }, { 'Content-Type': 'application/json' })
            break
          }
          case 'get':
            data = await this.request(resourcePath(query.ref), 'GET', undefined, query.ref.resource === 'secrets' ? { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' } : {})
            break
          case 'logs': {
            const params = new URLSearchParams({ container: query.container, previous: String(query.previous), sinceTime: query.sinceTime, tailLines: String(query.tailLines), timestamps: 'true' })
            const log = await this.request(`${resourcePath({ resource: 'pods', namespace: query.namespace, name: query.pod })}/log?${params}`, 'GET', undefined, {}, LOG_READ_BYTES) as { text: string; cut: boolean }
            data = log.text
            // Reaching tailLines means earlier lines may exist; a trailing newline is not a line.
            truncated = log.cut || log.text.replace(/\n$/, '').split('\n').length >= query.tailLines
            break
          }
          case 'list': {
            data = await this.listPage(query, query.limit)
            const list = data as { items?: unknown[]; metadata?: { continue?: string } }
            truncated = Boolean(list.metadata?.continue)
            // One bounded page per request; absence beyond this page is never evidence.
            data = { items: (list.items ?? []).slice(0, query.limit), continueToken: list.metadata?.continue ?? null, remaining: truncated ? 'Additional resources omitted; follow continueToken or narrow the namespace or selector.' : null }
            break
          }
        }
      }
      // Only the reader fingerprints literal values: a writer's dry-run of a guessed value would otherwise compare against them.
      const sanitized = sanitizeKubernetesResult(data, { fingerprints: this.mode === 'read' })
      truncated ||= kubernetesPayloadTruncated(data)
      return { observedAt: new Date().toISOString(), data: sanitized, truncated, error: null }
    } catch (error) {
      const status = error instanceof ApiFailure ? error.status : null
      const kind = status === 403 || status === 401 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 || status === 410 || status === 422 ? 'conflict' : status === 429 ? 'throttled' : mutationStarted && (!status || status >= 500) ? 'ambiguous' : status || error instanceof ResponseTooLarge || error instanceof TransportFailure ? 'unavailable' : 'invalid'
      return { observedAt: new Date().toISOString(), data: null, truncated: false, error: kind }
    }
  }
}
