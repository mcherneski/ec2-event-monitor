import express, { Request, Response } from 'express';
import expressWs from 'express-ws';
import dotenv from 'dotenv';
import { getConfig } from './types/config.js';
import { EventListener } from './eventListener.js';
import { Logger } from './utils/logger.js';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

const logger = new Logger('Server');

// Metrics object to track system performance
export const metrics = {
  events: {
    total: 0,
    batchTransfer: 0,
    batchMint: 0,
    batchBurn: 0,
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
  incrementEvent: (type: 'batchTransfer' | 'batchMint' | 'batchBurn' | 'errors') => {
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

// Test WebSocket connectivity
async function testWebSocketConnection(wsUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    logger.info('🔄 WEBSOCKET TEST: Starting connection test...', { 
      url: wsUrl,
      timestamp: new Date().toISOString()
    });
    
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: 5000,
      maxPayload: 100 * 1024 * 1024
    });

    const timeout = setTimeout(() => {
      logger.error('❌ WEBSOCKET TEST: Connection test timed out', {
        url: wsUrl,
        timestamp: new Date().toISOString()
      });
      ws.terminate();
      resolve(false);
    }, 10000);

    ws.on('open', () => {
      logger.info('✅ WEBSOCKET TEST: Connection established', {
        url: wsUrl,
        timestamp: new Date().toISOString()
      });
      clearTimeout(timeout);
      
      // Try to subscribe to newHeads to verify full connectivity
      const subscribeMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['newHeads']
      });
      
      logger.info('🔄 WEBSOCKET TEST: Sending subscription request', {
        message: subscribeMsg,
        timestamp: new Date().toISOString()
      });
      
      ws.send(subscribeMsg);
    });

    ws.on('message', (data) => {
      logger.info('✅ WEBSOCKET TEST: Received subscription response', {
        data: data.toString(),
        timestamp: new Date().toISOString()
      });
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    });

    ws.on('error', (error) => {
      logger.error('❌ WEBSOCKET TEST: Connection error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error,
        url: wsUrl,
        timestamp: new Date().toISOString()
      });
      clearTimeout(timeout);
      resolve(false);
    });

    ws.on('close', () => {
      logger.info('🔄 WEBSOCKET TEST: Connection closed', {
        timestamp: new Date().toISOString()
      });
    });
  });
}

// Start the server and event listener
const start = async () => {
  try {
    const config = await getConfig();
    logger.info('Configuration loaded', {
      port: config.port,
      environment: config.environment,
      nftContractAddress: config.nftContractAddress,
      stakingContractAddress: config.stakingContractAddress
    });

    // Test WebSocket connection before proceeding
    const wsConnected = await testWebSocketConnection(config.wsRpcUrl);
    if (!wsConnected) {
      throw new Error('Failed to establish WebSocket connection during startup test');
    }
    
    // Create Express app with WebSocket support
    const app = express();
    expressWs(app);

    // Create event listener instance
    logger.info('Initializing event listener...');
    const eventListener = new EventListener(config);

    // Health check endpoint
    app.get('/health', (_req: Request, res: Response) => {
      const wsStatus = metrics.websocket.connected;
      const lastEventAge = Date.now() - metrics.events.lastEventTime;
      
      logger.info('Health check requested', {
        wsConnected: wsStatus,
        lastEventAge,
        uptime: Date.now() - metrics.system.startTime
      });
      
      res.json({ 
        status: wsStatus ? 'healthy' : 'degraded',
        websocket: {
          connected: wsStatus,
          lastEventAge
        }
      });
    });

    // Readiness check endpoint
    app.get('/ready', (_req: Request, res: Response) => {
      const isReady = metrics.websocket.connected && 
        (Date.now() - metrics.kinesis.lastBatchTime < 60000);
      
      logger.info('Readiness check requested', {
        ready: isReady,
        wsConnected: metrics.websocket.connected,
        lastBatchAge: Date.now() - metrics.kinesis.lastBatchTime
      });
      
      res.json({ 
        status: isReady ? 'ready' : 'not_ready',
        websocketConnected: metrics.websocket.connected,
        lastBatchAge: Date.now() - metrics.kinesis.lastBatchTime
      });
    });

    // Metrics endpoint
    app.get('/metrics', (_req: Request, res: Response) => {
      const currentMetrics = {
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
      };
      
      logger.info('Metrics requested', currentMetrics);
      res.json(currentMetrics);
    });

    // Start the event listener
    logger.info('Starting event listener...');
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