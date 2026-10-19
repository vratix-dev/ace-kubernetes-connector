{{/* Object names match the manifest Ace generates, so either installer can replace the other. */}}
{{- define "connector.name" -}}
{{- printf "ace-%s-%s" .Values.mode (substr 0 8 .Values.connectorId) -}}
{{- end -}}

{{- define "connector.secretName" -}}
{{- default (include "connector.name" .) .Values.existingSecret -}}
{{- end -}}

{{- define "connector.subject" -}}
- kind: ServiceAccount
  name: {{ include "connector.name" . }}
  namespace: {{ .Release.Namespace }}
{{- end -}}

{{- define "connector.validate" -}}
{{- if and .Values.token .Values.existingSecret -}}
{{- fail "Set either existingSecret or token, not both." -}}
{{- end -}}
{{- if not (or .Values.token .Values.existingSecret) -}}
{{- fail "Set existingSecret to a Secret holding the Ace connector credential under the key \"token\", or pass it with --set-file token=PATH." -}}
{{- end -}}
{{- if and .Values.token (lt (len (trim .Values.token)) 32) -}}
{{- fail "The Ace connector credential is too short." -}}
{{- end -}}
{{- end -}}

{{/* Namespaced read access: every supported namespaced resource except Secrets, plus pod logs. */}}
{{- define "connector.readRules" -}}
- apiGroups: [""]
  resources: [pods, services, endpoints, configmaps, events, persistentvolumeclaims, resourcequotas, limitranges, serviceaccounts, pods/log]
  verbs: [get, list]
- apiGroups: [apps]
  resources: [deployments, replicasets, statefulsets, daemonsets, controllerrevisions]
  verbs: [get, list]
- apiGroups: [batch]
  resources: [jobs, cronjobs]
  verbs: [get, list]
- apiGroups: [networking.k8s.io]
  resources: [ingresses, networkpolicies]
  verbs: [get, list]
- apiGroups: [discovery.k8s.io]
  resources: [endpointslices]
  verbs: [get, list]
- apiGroups: [autoscaling]
  resources: [horizontalpodautoscalers]
  verbs: [get, list]
- apiGroups: [policy]
  resources: [poddisruptionbudgets]
  verbs: [get, list]
- apiGroups: [rbac.authorization.k8s.io]
  resources: [roles, rolebindings]
  verbs: [get, list]
{{- end -}}

{{- define "connector.clusterReadRules" -}}
- apiGroups: [""]
  resources: [nodes]
  verbs: [get, list]
- apiGroups: [""]
  resources: [namespaces]
  verbs: [get, list]
- apiGroups: [""]
  resources: [persistentvolumes]
  verbs: [get, list]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses]
  verbs: [get, list]
- apiGroups: [rbac.authorization.k8s.io]
  resources: [clusterroles]
  verbs: [get, list]
- apiGroups: [rbac.authorization.k8s.io]
  resources: [clusterrolebindings]
  verbs: [get, list]
- apiGroups: [admissionregistration.k8s.io]
  resources: [mutatingwebhookconfigurations]
  verbs: [get, list]
- apiGroups: [admissionregistration.k8s.io]
  resources: [validatingwebhookconfigurations]
  verbs: [get, list]
{{- end -}}
