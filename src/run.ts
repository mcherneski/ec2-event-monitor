import express, { Request, Response } from 'express';
import expressWs from 'express-ws';
import dotenv from 'dotenv';
import { getConfig } from './types/config.js';
import { EventListener } from './eventListener.js';
import { Logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

const logger = new Logger('Server');

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
      res.json({ status: 'ready' });
    });

    // Metrics endpoint
    app.get('/metrics', (_req: Request, res: Response) => {
      // TODO: Implement custom metrics endpoint if needed
      res.json({});
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
    logger.error('Failed to start application', error);
    process.exit(1);
  }
};

start(); 