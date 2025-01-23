export interface Logger {
  info(message: string, data?: any): void;
  error(message: string, data?: any): void;
} 