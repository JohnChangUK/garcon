import {
  AgentCallError,
  type AgentSteering,
  type AgentSteerResult,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from './resource-table.js';
import type { AgentProducerAdapter } from './producer-adapter.js';
import type { RuntimeSteerRequest, RuntimeSteerTarget } from './runtime-events.js';

const PREPARATION_TIMEOUT_MS = 30_000;

export function createAgentSteering(
  producer: AgentProducerAdapter,
  runtime: {
    captureTarget(agentSessionId: string): RuntimeSteerTarget | null;
    steer(request: RuntimeSteerRequest): Promise<AgentSteerResult>;
    readonly acceptsAttachments?: true;
  },
): AgentSteering {
  const targets = new AgentResourceTable<'steer-target', {
    readonly operation: NonNullable<ReturnType<AgentProducerAdapter['expectedOperation']>>;
    readonly target: RuntimeSteerTarget;
    timer: ReturnType<typeof setTimeout> | null;
  }>(producer.producers.scope, 'steer-target', 256);
  return {
    ...(runtime.acceptsAttachments ? { acceptsAttachments: true as const } : {}),
    async captureTarget(request, options) {
      options?.signal?.throwIfAborted();
      const operation = producer.expectedOperation(request);
      if (!operation) return null;
      const target = runtime.captureTarget(request.agentSessionId);
      if (!target) return null;
      const captured = { operation, target, timer: null as ReturnType<typeof setTimeout> | null };
      const ref = targets.add(captured);
      captured.timer = setTimeout(() => targets.delete(ref), PREPARATION_TIMEOUT_MS);
      captured.timer.unref();
      return ref;
    },
    async steer(request, options) {
      options?.signal?.throwIfAborted();
      if (!request.target) return { kind: 'rejected', reason: 'no-active-turn', message: 'No active turn' };
      // Refuses rather than dropping attachments the runtime cannot deliver mid-turn.
      if (request.attachments.length > 0 && !runtime.acceptsAttachments) {
        return { kind: 'rejected', reason: 'invalid-input', message: 'This agent cannot take attachments while steering' };
      }
      const captured = targets.take(request.target);
      if (captured.timer) clearTimeout(captured.timer);
      if (captured.operation.binding.chatId !== request.chatId
        || captured.operation.agentSessionId !== request.agentSessionId) {
        throw new AgentCallError('rejected', 'Steering resource mismatch', 'STALE_RESOURCE');
      }
      producer.assertCurrent(captured.operation);
      return runtime.steer({
        ...request,
        target: captured.target,
        prepareDelivery: async () => {
          options?.signal?.throwIfAborted();
          producer.assertCurrent(captured.operation);
        },
      });
    },
  };
}
