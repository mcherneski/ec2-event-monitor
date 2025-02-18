import { Logger } from './logger';

export const handleError = (
  error: unknown,
  context: string,
  logger: Logger,
  additionalData?: Record<string, unknown>
): void => {
  logger.error(`Error in ${context}`, {
    error: error instanceof Error ? {
      message: error.message,
      stack: error.stack,
      name: error.name
    } : error,
    ...additionalData
  });
}; 