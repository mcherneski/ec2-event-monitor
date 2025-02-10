import express, { Request, Response } from 'express';
import expressWs from 'express-ws';
import dotenv from 'dotenv';
import { getConfig } from './types/config.js';
import { EventListener } from './eventListener.js';
import { Logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

const logger = new Logger('Server');

// Metrics object to track system performance
export const metrics = {
  events: {
    total: 0,
    transfer: 0,
    stake: 0,
    unstake: 0,
    errors: 0,
    lastEventTime: Date.now()
  },
  websocket: {
    connected: false,
    lastReconnectAttempt: Date.now(),
    reconnectAttempts: 0,
    messagesProcessed: 0,
    circuitBreakerOpen: false
  },
  kinesis: {
    batchesSent: 0,
    recordsSent: 0,
    errors: 0,
    lastBatchTime: Date.now()
  },
  system: {
    startTime: Date.now(),
    heapTotal: 0,
    heapUsed: 0,
    rss: 0
  }
};

export const updateMetrics = {
  incrementEvent: (type: 'transfer' | 'stake' | 'unstake' | 'errors') => {
    metrics.events[type]++;
    metrics.events.total++;
    metrics.events.lastEventTime = Date.now();
  },
  updateWebsocket: (update: Partial<typeof metrics.websocket>) => {
    Object.assign(metrics.websocket, update);
  },
  updateKinesis: (update: Partial<typeof metrics.kinesis>) => {
    Object.assign(metrics.kinesis, update);
  }
};

// Update system metrics every 10 seconds
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  metrics.system.heapTotal = memoryUsage.heapTotal;
  metrics.system.heapUsed = memoryUsage.heapUsed;
  metrics.system.rss = memoryUsage.rss;
}, 10000);

// Start the server and event listener
const start = async () => {
  try {
    const config = await getConfig();
    
    // Create Express app with WebSocket support
    const app = express();
    expressWs(app);

    // Create event listener instance
    const eventListener = new EventListener(config);

    // Health check endpoint
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'healthy' });
    });

    // Readiness check endpoint
    app.get('/ready', (_req: Request, res: Response) => {
      const isReady = metrics.websocket.connected && 
        (Date.now() - metrics.kinesis.lastBatchTime < 60000); // Last batch within 1 minute
      res.json({ 
        status: isReady ? 'ready' : 'not_ready',
        websocketConnected: metrics.websocket.connected,
        lastBatchAge: Date.now() - metrics.kinesis.lastBatchTime
      });
    });

    // Metrics endpoint
    app.get('/metrics', (_req: Request, res: Response) => {
      res.json({
        events: {
          ...metrics.events,
          eventsPerMinute: metrics.events.total / (metrics.system.heapTotal / 1024 / 1024 / 60)
        },
        websocket: {
          ...metrics.websocket,
          lastReconnectAgo: Date.now() - metrics.websocket.lastReconnectAttempt
        },
        kinesis: {
          ...metrics.kinesis,
          averageBatchSize: metrics.kinesis.batchesSent > 0 ? 
            metrics.kinesis.recordsSent / metrics.kinesis.batchesSent : 0,
          lastBatchAgo: Date.now() - metrics.kinesis.lastBatchTime
        },
        system: {
          ...metrics.system,
          memoryUsageMB: metrics.system.rss / 1024 / 1024,
          uptimeHours: metrics.system.heapTotal / 3600
        }
      });
    });

    // Start the event listener
    await eventListener.start();
    logger.info('Event listener started successfully');

    // Start the Express server
    app.listen(config.port, () => {
      logger.info(`Server listening on port ${config.port}`);
    });

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      await eventListener.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start application', {
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error,
      config: {
        NODE_ENV: process.env.NODE_ENV,
        AWS_REGION: process.env.AWS_REGION,
        AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID
      }
    });
    process.exit(1);
  }
};

start(); 