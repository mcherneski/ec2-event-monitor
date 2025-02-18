import { Logger as ILogger } from '../types/logger';
import * as fs from 'fs';
import * as path from 'path';

export class Logger implements ILogger {
  private context: string;
  private logPath: string;
  private errorLogPath: string;
  private useFileLogging: boolean;

  constructor(
    context: string, 
    logPath: string = '/var/log/event-monitor.log',
    errorLogPath: string = '/var/log/event-monitor.error.log'
  ) {
    this.context = context;
    this.logPath = logPath;
    this.errorLogPath = errorLogPath;
    this.useFileLogging = false; // Start with file logging disabled

    // Try to enable file logging if we can write to the directories
    try {
      // Setup main log file
      const logDir = path.dirname(this.logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.accessSync(logDir, fs.constants.W_OK);

      // Setup error log file
      const errorLogDir = path.dirname(this.errorLogPath);
      if (!fs.existsSync(errorLogDir)) {
        fs.mkdirSync(errorLogDir, { recursive: true });
      }
      fs.accessSync(errorLogDir, fs.constants.W_OK);

      this.useFileLogging = true;
    } catch (error) {
      console.warn(`File logging disabled - ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.useFileLogging = false;
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

  private writeToFile(logEntry: string, isError: boolean = false) {
    if (!this.useFileLogging) return;
    
    try {
      const filePath = isError ? this.errorLogPath : this.logPath;
      fs.appendFileSync(filePath, logEntry + '\n');
    } catch (error) {
      console.warn(`Failed to write to ${isError ? 'error ' : ''}log file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Disable file logging on error
      this.useFileLogging = false;
    }
  }

  private formatLogEntry(level: string, message: string, data?: any): string {
    return JSON.stringify({
      level,
      context: this.context,
      message,
      ...(data && { data: this.serializeData(data) }),
      timestamp: new Date().toISOString()
    });
  }

  info(message: string, data?: any) {
    const logEntry = this.formatLogEntry('INFO', message, data);
    console.log(logEntry);
    this.writeToFile(logEntry);
  }

  error(message: string, data?: any) {
    const logEntry = this.formatLogEntry('ERROR', message, data);
    console.error(logEntry);
    this.writeToFile(logEntry, true); // Write to error log file
  }

  warn(message: string, data?: any) {
    const logEntry = this.formatLogEntry('WARN', message, data);
    console.warn(logEntry);
    this.writeToFile(logEntry);
  }
} 