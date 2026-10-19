import https from 'node:https'
import http from 'node:http'
import { Writable } from 'node:stream'
import { Exec, KubeConfig } from '@kubernetes/client-node'
import { assertConnectorScope, kubernetesResources, resourcePath, type ConnectorResult, type ConnectorScope, type KubernetesCommand } from './protocol'
import { sanitizeKubernetes, kubernetesPayloadTruncated } from './sanitize'

class ApiFailure extends Error {
  constructor(readonly status: number) { super(`Kubernetes API returned ${status}.`) }
}

/** Executes scoped commands against the local Kubernetes API. */
export class KubernetesConnectorClient {
  constructor(private readonly kube: KubeConfig, readonly scope: ConnectorScope, readonly mode: 'read' | 'write') {}

  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
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
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 2_000_000) { response.destroy(); reject(new Error('Kubernetes response exceeded the byte limit.')); return }
          chunks.push(Buffer.from(chunk))
        })
        response.on('error', reject)
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) { reject(new ApiFailure(response.statusCode ?? 500)); return }
          const text = Buffer.concat(chunks).toString('utf8')
          try { resolve(JSON.parse(text)) } catch { resolve(text) }
        })
      })
      const deadline = setTimeout(() => request.destroy(new Error('Kubernetes request timed out.')), 15_000)
      request.on('close', () => clearTimeout(deadline))
      request.on('error', reject)
      request.end(payload)
    })
  }

  private async execute(command: Extract<KubernetesCommand, { mode: 'write' }>): Promise<unknown> {
    const mutation = command.mutation
    const path = resourcePath(mutation.ref)
    const suffix = command.dryRun ? '?dryRun=All' : ''
    if (mutation.operation === 'patch') {
      return this.request(path + suffix, 'PATCH', [
        { op: 'test', path: '/metadata/uid', value: mutation.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: mutation.resourceVersion },
        ...mutation.patch,
      ], { 'Content-Type': 'application/json-patch+json' })
    }
    if (mutation.operation === 'delete') return this.request(path + suffix, 'DELETE', {
      apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
      preconditions: { uid: mutation.uid, resourceVersion: mutation.resourceVersion },
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
            const params = new URLSearchParams({ container: query.container, previous: String(query.previous), sinceTime: query.sinceTime, tailLines: String(query.tailLines), limitBytes: '32000', timestamps: 'true' })
            data = await this.request(`${resourcePath({ resource: 'pods', namespace: query.namespace, name: query.pod })}/log?${params}`)
            truncated = typeof data === 'string' && (Buffer.byteLength(data) >= 31_000 || data.split('\n').length >= query.tailLines)
            break
          }
          case 'list': {
            const params = new URLSearchParams({ limit: String(query.limit) })
            if (query.continueToken) params.set('continue', query.continueToken)
            if (query.selector) params.set('labelSelector', query.selector)
            data = await this.request(`${resourcePath(query)}?${params}`, 'GET', undefined, query.resource === 'secrets' ? { Accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' } : {})
            const list = data as { items?: unknown[]; metadata?: { continue?: string } }
            truncated = Boolean(list.metadata?.continue)
            // One bounded page per request; absence beyond this page is never evidence.
            data = { items: (list.items ?? []).slice(0, query.limit), continueToken: list.metadata?.continue ?? null, remaining: truncated ? 'Additional resources omitted; follow continueToken or narrow the namespace or selector.' : null }
            break
          }
        }
      }
      const sanitized = sanitizeKubernetes(data)
      truncated ||= kubernetesPayloadTruncated(data)
      return { observedAt: new Date().toISOString(), data: sanitized, truncated, error: null }
    } catch (error) {
      const status = error instanceof ApiFailure ? error.status : null
      const kind = status === 403 || status === 401 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 || status === 410 || status === 422 ? 'conflict' : status === 429 ? 'throttled' : mutationStarted && (!status || status >= 500) ? 'ambiguous' : status ? 'unavailable' : 'invalid'
      return { observedAt: new Date().toISOString(), data: null, truncated: false, error: kind }
    }
  }
}
