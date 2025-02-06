import { Logger as ILogger } from '../types/logger';

export class Logger implements ILogger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  // Helper function to handle BigInt serialization
  private serializeData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'bigint') {
      return data.toString();
    }

    if (Array.isArray(data)) {
      return data.map(item => this.serializeData(item));
    }

    if (typeof data === 'object') {
      const serialized: any = {};
      for (const [key, value] of Object.entries(data)) {
        serialized[key] = this.serializeData(value);
      }
      return serialized;
    }

    return data;
  }

  info(message: string, data?: any) {
    console.log(JSON.stringify({
      level: 'INFO',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    }));
  }

  error(message: string, data?: any) {
    console.error(JSON.stringify({
      level: 'ERROR',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    }));
  }

  warn(message: string, data?: any) {
    console.warn(JSON.stringify({
      level: 'WARN',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    }));
  }
} 