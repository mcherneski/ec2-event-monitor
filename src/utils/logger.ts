export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, data?: any) {
    console.log(JSON.stringify({
      level: 'INFO',
      context: this.context,
      message,
      data,
      timestamp: new Date().toISOString()
    }));
  }

  error(message: string, error?: any) {
    console.error(JSON.stringify({
      level: 'ERROR',
      context: this.context,
      message,
      error,
      timestamp: new Date().toISOString()
    }));
  }
} 