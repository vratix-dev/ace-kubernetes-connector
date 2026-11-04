import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { kubernetesResources } from '../src/protocol'

const chart = fileURLToPath(new URL('../chart/ace-kubernetes-connector', import.meta.url))
const base = {
  connectorId: '00000000-0000-4000-8000-000000000001', mode: 'read', apiUrl: 'https://ace.example', clusterName: 'production-eu',
  namespaces: ['checkout', 'billing'], clusterResources: false, image: { digest: 'sha256:' + 'a'.repeat(64) }, existingSecret: 'ace-read-00000000',
}
type K8sObject = { kind: string; metadata: { name: string; namespace?: string }; [key: string]: any }
function helm(values: object, extra: string[] = []) {
  return spawnSync('helm', ['template', 'connector', chart, '--namespace', 'ace-connectors', '--values', '-', ...extra], { input: JSON.stringify(values), encoding: 'utf8' })
}
function render(values: object, extra: string[] = []): K8sObject[] {
  const result = helm(values, extra)
  if (result.status !== 0) throw new Error(result.stderr)
  return parseAllDocuments(result.stdout).map(document => document.toJSON()).filter(Boolean)
}
const groupOf = (api: string) => api === 'v1' ? '' : api.split('/')[0]

describe('Helm chart', () => {
  it('is available to the test run', () => {
    expect(execFileSync('helm', ['version', '--short'], { encoding: 'utf8' })).toMatch(/^v[34]\./)
  })

  it('by default covers every namespace, never Secrets, and gives cluster-scoped writes only with cluster administration', () => {
    const { clusterResources: _, ...unset } = base
    const grants = (role: K8sObject): string[] => role.rules.flatMap((rule: { apiGroups: string[]; resources: string[] }) => rule.apiGroups.flatMap(group => rule.resources.map(resource => `${group}/${resource}`)))
    const reader = render(unset)
    const read = reader.find(item => item.kind === 'ClusterRole' && item.metadata.name === 'ace-read-00000000-namespaces')!
    expect(read.rules.every((rule: { verbs: string[] }) => rule.verbs.join() === 'get,list')).toBe(true)
    expect(grants(read)).not.toContain('/secrets')
    expect(grants(reader.find(item => item.kind === 'ClusterRole' && item.metadata.name === 'ace-read-00000000')!)).toContain('admissionregistration.k8s.io/mutatingwebhookconfigurations')
    expect(reader.find(item => item.kind === 'Deployment')!.spec.template.spec.containers[0].env).toEqual(expect.arrayContaining([{ name: 'ACE_ALL_NAMESPACES', value: 'true' }, { name: 'ACE_CLUSTER_RESOURCES', value: 'true' }]))
    // A writer changes namespaced objects anywhere (a fix may sit in another namespace), never Secrets or cluster-scoped objects without cluster administration.
    const writer = render({ ...unset, mode: 'write', existingSecret: 'ace-write-00000000', namespaces: [] })
    const write = writer.find(item => item.kind === 'ClusterRole' && item.metadata.name === 'ace-write-00000000-namespaces')!
    expect(grants(write)).toEqual(expect.arrayContaining(['apps/deployments', '/configmaps', '/pods/eviction']))
    expect(grants(write).filter(grant => grant === '/secrets' || grant.includes('*') || ['/nodes', '/namespaces', '/persistentvolumes'].includes(grant))).toEqual([])
    expect(writer.filter(item => item.kind === 'ClusterRole').map(role => role.metadata.name).sort()).toEqual(['ace-write-00000000-identity', 'ace-write-00000000-namespaces'])
    // Limited to listed namespaces, it gets a Role in each; with none listed it is refused.
    expect(render({ ...unset, mode: 'write', existingSecret: 'ace-write-00000000', allNamespaces: false }).filter(item => item.kind === 'Role').map(role => role.metadata.namespace)).toEqual(['checkout', 'billing'])
    expect(helm({ ...unset, mode: 'write', existingSecret: 'ace-write-00000000', allNamespaces: false, namespaces: [] }).status).not.toBe(0)
  })

  it('grants the reader get/list on every supported namespaced resource except Secrets', () => {
    const roles = render({ ...base, allNamespaces: false }).filter(item => item.kind === 'Role')
    expect(roles.map(role => role.metadata.namespace)).toEqual(['checkout', 'billing'])
    const expected = Object.entries(kubernetesResources).filter(([resource, spec]) => spec.namespaced && resource !== 'secrets').map(([resource, spec]) => `${groupOf(spec.api)}/${resource}`)
    for (const role of roles) {
      const granted = role.rules.flatMap((rule: { apiGroups: string[]; resources: string[]; verbs: string[] }) => {
        expect(rule.verbs).toEqual(['get', 'list'])
        return rule.apiGroups.flatMap(group => rule.resources.map(resource => `${group}/${resource}`))
      })
      expect(granted.sort()).toEqual([...expected, '/pods/log'].sort())
    }
    expect(render({ ...base, allNamespaces: false }).some(item => item.kind === 'ClusterRole' && ['ace-read-00000000', 'ace-read-00000000-namespaces'].includes(item.metadata.name))).toBe(false)
  })

  it('grants cluster-scoped reads only when requested', () => {
    const role = render({ ...base, clusterResources: true }).find(item => item.kind === 'ClusterRole' && item.metadata.name === 'ace-read-00000000')!
    const expected = Object.entries(kubernetesResources).filter(([, spec]) => !spec.namespaced).map(([resource, spec]) => `${groupOf(spec.api)}/${resource}`)
    expect(role.rules.flatMap((rule: { apiGroups: string[]; resources: string[] }) => rule.apiGroups.flatMap(group => rule.resources.map(resource => `${group}/${resource}`))).sort()).toEqual(expected.sort())
  })

  it('uses an existing credential Secret without rendering one', () => {
    const objects = render(base)
    expect(objects.some(item => item.kind === 'Secret')).toBe(false)
    const deployment = objects.find(item => item.kind === 'Deployment')!
    expect(deployment.spec.template.spec.volumes[0].secret.secretName).toBe('ace-read-00000000')
    expect(deployment.spec.template.spec.containers[0].image).toBe('ghcr.io/vratix-dev/ace-kubernetes-connector@sha256:' + 'a'.repeat(64))
  })

  it('renders a credential Secret from a token file value', () => {
    const { existingSecret: _, ...values } = base
    const secret = render({ ...values, token: 'b'.repeat(43) + '\n' }).find(item => item.kind === 'Secret')!
    expect(secret).toMatchObject({ metadata: { name: 'ace-read-00000000', namespace: 'ace-connectors' }, stringData: { token: 'b'.repeat(43) } })
  })

  it('rejects unpinned images, insecure endpoints and ambiguous credentials', () => {
    const { existingSecret: _, ...withoutCredential } = base
    for (const values of [
      { ...base, image: { digest: '' } },
      { ...base, image: { digest: 'latest' } },
      { ...base, image: { repository: 'registry.example/connector:latest', digest: base.image.digest } },
      { ...base, apiUrl: 'http://ace.example' },
      { ...base, apiUrl: 'https://ace.example/prefix' },
      { ...base, namespaces: [], allNamespaces: false },
      { ...base, token: 'c'.repeat(43) },
      withoutCredential,
      { ...withoutCredential, token: 'short' },
      { ...base, unexpected: true },
    ]) expect(helm(values).status, JSON.stringify(values)).not.toBe(0)
  })
})
