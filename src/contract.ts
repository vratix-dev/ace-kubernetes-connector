import { z } from 'zod'
import { connectorResultSchema, connectorScopeSchema, kubernetesCommandSchema, kubernetesResources } from './protocol'

/** The parts of the protocol both sides must agree on, as plain JSON. */
export function protocolContract() {
  return {
    endpoint: '/api/connectors/kubernetes/{mode}/{connectorId}',
    resources: kubernetesResources,
    scope: z.toJSONSchema(connectorScopeSchema),
    command: z.toJSONSchema(kubernetesCommandSchema),
    result: z.toJSONSchema(connectorResultSchema),
  }
}
