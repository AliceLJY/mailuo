export * from '../../../shared/core/llm/provider.ts';

import { ConfigurationError } from '../../../shared/core/llm/provider.ts';

export function requireEnv(envName: string, value = process.env[envName]): string {
  if (!value) {
    throw new ConfigurationError(
      `Missing required environment variable ${envName}`,
      envName,
      'CONFIG_ERROR',
    );
  }

  return value;
}
