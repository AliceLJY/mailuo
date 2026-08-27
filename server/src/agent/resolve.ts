import {
  resolveParticipants as resolveParticipantsCore,
  type ResolveParticipantsOptions as CoreResolveParticipantsOptions,
} from '../../../shared/core/agent/resolve.ts';
import { createDeepSeekProvider } from '../llm/deepseek.ts';

export type {
  ParticipantResolution,
  ResolvableContact,
} from '../../../shared/core/agent/resolve.ts';

export type ResolveParticipantsOptions = Omit<
  CoreResolveParticipantsOptions,
  'providerFactory'
>;

export function resolveParticipants(options: ResolveParticipantsOptions) {
  return resolveParticipantsCore({
    ...options,
    providerFactory: createDeepSeekProvider,
  });
}
