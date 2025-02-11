import { Logger as ILogger } from '../types/logger';
import * as fs from 'fs';
import * as path from 'path';

export class Logger implements ILogger {
  private context: string;
  private logPath: string = '/var/log/event-listener/event-monitor.log';

  constructor(context: string) {
    this.context = context;
    // Ensure log directory exists
    const logDir = path.dirname(this.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
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

  private writeToFile(logEntry: string) {
    try {
      fs.appendFileSync(this.logPath, logEntry + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  info(message: string, data?: any) {
    const logEntry = JSON.stringify({
      level: 'INFO',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    });
    this.writeToFile(logEntry);
    console.log(logEntry);
  }

  error(message: string, data?: any) {
    const logEntry = JSON.stringify({
      level: 'ERROR',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    });
    this.writeToFile(logEntry);
    console.error(logEntry);
  }

  warn(message: string, data?: any) {
    const logEntry = JSON.stringify({
      level: 'WARN',
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    });
    this.writeToFile(logEntry);
    console.warn(logEntry);
  }
} 