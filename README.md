# Ace Kubernetes connector

The connector runs inside your cluster and lets Ace inspect it: by default the reader reads the whole cluster, and the writer acts only in the namespaces you choose. It opens outbound HTTPS connections to your Ace installation. No inbound port, exposed Kubernetes API or uploaded kubeconfig is needed.

- **Reader:** get/list on supported resources and container logs in every namespace, plus cluster-scoped reads (nodes, namespaces, storage, RBAC and admission webhooks), so an incident whose cause sits in another namespace, such as DNS in `kube-system` or an admission controller's own namespace, can be traced. It cannot read Secrets. Set `allNamespaces=false` and `clusterResources=false` to limit it to the selected namespaces. An upgrade that does not set them keeps a reader's earlier scope; set them to `true` to widen it. Secrets are read, as metadata only, in the selected namespaces alone. Literal environment values leave the cluster only as keyed fingerprints: within one connector run equal values have equal fingerprints, the key never leaves the reader's process, and credential-named values are not fingerprinted at all.
- **Writer (optional):** a separate release with its own credential and broad access within the selected namespaces, or optionally the whole cluster, used only for changes you approve in Ace. This includes pod evictions through the Eviction API, which respects PodDisruptionBudgets, and status patches of custom resources (an Argo Rollout's abort or promote).
- **GitOps and progressive delivery:** the reader also gets and lists Argo CD `Application`, Argo Rollouts `Rollout` and Flux `Kustomization`/`HelmRelease` objects when those CRDs are installed, in every namespace a cluster-wide reader reads. Include the namespace your Argo CD Applications or Flux objects live in (for example `argocd` or `flux-system`) to let Ace see and, with the writer, act on them.
  - **These objects reach beyond their namespace.** Scope is checked on the object's own namespace, so a writer that can change an `Application`, `Kustomization` or `HelmRelease` can affect the workloads it manages in other namespaces. Deleting an Application with a cascade finalizer deletes those workloads. Only give the writer these namespaces if that reach is acceptable.

Every poll reports the connector version and the features it supports, including which of those custom resources the cluster serves. Ace requires this report and works with every version on its supported list, using only the features each one reports. A version not on the list is refused with a clear reason.

Results are bounded and pass through redaction before they leave the cluster. Helm values, Flux substitutions and inline Kustomize patches keep their structure but not their values. Other configuration, such as ConfigMap data, is redacted by key name and known credential formats, so a credential under an unremarkable key can still leave the cluster: keep credentials in Secrets. Kubernetes credentials stay in the cluster.

## Install with Helm

Ace setup shows the exact commands for your connection. They follow this pattern:

```sh
kubectl create namespace ace-connectors
# The credential comes from a file downloaded during setup, so it never appears in shell history.
kubectl -n ace-connectors create secret generic ace-read-0123abcd --from-file=token=ace-read-0123abcd.token
helm upgrade --install ace-read-0123abcd oci://ghcr.io/vratix-dev/charts/ace-kubernetes-connector \
  --version 0.2.0 --namespace ace-connectors \
  --set connectorId=0123abcd-... --set mode=read --set apiUrl=https://ace.example.com \
  --set clusterName=production --set 'namespaces={checkout,billing}' \
  --set existingSecret=ace-read-0123abcd
```

The same values work in a values file for Argo CD, Flux or other GitOps tools. Keep the credential out of Git by using `existingSecret` with your secret manager.

| Value | Description |
| --- | --- |
| `connectorId` | Connector ID issued by Ace. |
| `mode` | `read` or `write`. Install the reader and writer as separate releases. |
| `apiUrl` | HTTPS origin of your Ace installation. |
| `clusterName` | Display name of the cluster in Ace. |
| `namespaces` | Namespaces Ace watches and maps workloads to. The writer acts only in these. |
| `allNamespaces` | Reader only: read every namespace. Unset: `true` on a new install, unchanged (`false`) on an upgrade. The writer refuses it. |
| `clusterResources` | Also grant cluster-scoped access. Unset: `true` for a newly installed reader, `false` on an upgrade and for the writer. |
| `image.repository` / `image.digest` | Released charts pin the image they were tested with. Override both to use a registry mirror. Mutable tags are rejected. |
| `imagePullSecrets` | Registry Secrets for a private mirror. |
| `existingSecret` | Secret with the Ace credential under the key `token`. |
| `token` | Alternative to `existingSecret`: `--set-file token=PATH`. Helm then keeps the credential in its release record. |

The chart creates objects named `ace-<mode>-<first 8 characters of the connector ID>` in the release namespace, plus a cluster-wide read `ClusterRole` for a reader (or `Role`/`RoleBinding` objects in each selected namespace for a writer, or a reader limited with `allNamespaces=false`). It does not create or delete the namespace itself.

The pod runs as a non-root user with a read-only root filesystem, no privilege escalation, all capabilities dropped, the `RuntimeDefault` seccomp profile and bounded CPU and memory. Readiness requires a recent successful connection to Ace.

### Rotate, upgrade or remove

- **Rotate the credential:** replace the Secret contents. The connector rereads its token file, so it needs no restart.
- **Upgrade:** run `helm upgrade` with the new chart version, on the reader and writer. A supported older version keeps working until you do. A newly installed CRD is picked up within a minute.
- **Remove:** disconnect in Ace first, then `helm uninstall <release> -n ace-connectors` and delete the credential Secret.

## Images and charts

| Artifact | Location |
| --- | --- |
| Image | `ghcr.io/vratix-dev/ace-kubernetes-connector` (`linux/amd64`, `linux/arm64`) |
| Chart | `oci://ghcr.io/vratix-dev/charts/ace-kubernetes-connector` |

Every release image is scanned for high and critical vulnerabilities, including unfixed ones, before it is published, and ships with SBOM and provenance attestations. Each pull request from this repository builds a preview image tagged `pr-<number>`. Preview images are for testing only.

## Development

Requires Node.js 24 and Helm 3.

```sh
npm ci
npm run typecheck
npm test
```

`src/protocol.ts` defines the messages exchanged with Ace. `contract/protocol.json` is its JSON Schema form, and Ace checks its own copy of the protocol against it. After changing the protocol, run `npm run contract` and commit the result. CI fails when the contract is stale.

### Release

1. Set the same version in `package.json`, `connectorVersion` in `src/client.ts`, and `version` and `appVersion` in `chart/ace-kubernetes-connector/Chart.yaml`.
2. Merge to `main`, then push a tag such as `v0.2.0`.

The release workflow builds and scans both architectures, publishes the image, writes the image digest into the chart, pushes the chart to GHCR and creates a GitHub release that lists the digest.

## Security

Report vulnerabilities privately through **Security → Report a vulnerability** on this repository. Do not open public issues for security reports.
