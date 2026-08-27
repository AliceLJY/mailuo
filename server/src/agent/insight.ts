import {
  generateInsights as generateInsightsCore,
  type GenerateInsightsOptions,
} from '../../../shared/core/agent/insight.ts';
import { createTextProvider } from '../llm/text.ts';

export type {
  GenerateInsightsOptions,
  InsightContactRecord,
  InsightContextRecord,
  InsightGenerationDb,
  InsightGenerationEntry,
  InsightGenerationRecord,
  InsightGenerationResult,
  InsightKind,
  InsightObservationRecord,
  InsightSummaryRecord,
} from '../../../shared/core/agent/insight.ts';

export function generateInsights(options: GenerateInsightsOptions) {
  return generateInsightsCore({
    ...options,
    provider: options.provider ?? createTextProvider(),
  });
}
