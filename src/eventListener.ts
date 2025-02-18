import { WebSocket } from 'ws';
import { Contract, WebSocketProvider, isAddress } from 'ethers';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Logger } from './utils/logger';
import { Config } from './types/config';
import { updateMetrics } from './run';
import { initializeHandlers, handleBatchMint, handleBatchBurn, handleBatchTransfer, handleStake, handleUnstake } from './eventHandlers';
import { OnChainEvent, BatchMintEvent, BatchBurnEvent, BatchTransferEvent, StakeEvent, UnstakeEvent } from './types/events';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event BatchMint(address indexed to, uint256 startTokenId, uint256 quantity)',
  'event BatchBurn(address indexed from, uint256 startTokenId, uint256 quantity)',
  'event BatchTransfer(address indexed from, address indexed to, uint256 startTokenId, uint256 quantity)',
  'event Stake(address indexed account, uint256 tokenId)',
  'event Unstake(address indexed account, uint256 tokenId)'
];

export class EventListener {
  private readonly config: Config;
  private readonly logger: Logger;
  private ws?: WebSocket;
  private provider!: WebSocketProvider;
  private nftContract!: Contract;
  private kinesis: KinesisClient;
  private dynamoDb: DynamoDBDocument;
  private reconnectAttempts: number = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private maxReconnectAttempts: number = parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS || '10');
  private baseReconnectDelay: number = parseInt(process.env.WS_RECONNECT_DELAY || '1000');
  private maxReconnectDelay: number = 300000; // 5 minutes
  private circuitBreakerTimeout: number = parseInt(process.env.WS_CIRCUIT_BREAKER_TIMEOUT || '600000');
  private lastCircuitBreakerReset: number = Date.now();
  private isCircuitBreakerOpen: boolean = false;
  private wsInitializing: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('EventListener');
    
    try {
      // Get environment from config
      const env = process.env.NODE_ENV || 'dev';
      const tableSuffix = env === 'prod' ? '-prod-v5' : '';
      
      this.logger.info('Starting event listener with config', {
        nftContractAddress: config.nftContractAddress,
        wsRpcUrl: config.wsRpcUrl,
        kinesisStreamName: config.kinesisStreamName,
        dynamoTableName: `${config.kinesisStreamName}${tableSuffix}-events`,
        wsConfig: {
          maxReconnectAttempts: this.maxReconnectAttempts,
          baseReconnectDelay: this.baseReconnectDelay,
          circuitBreakerTimeout: this.circuitBreakerTimeout
        }
      });

      // Initialize DynamoDB client with retry configuration
      const dynamoDbClient = new DynamoDBClient({ 
        region: config.awsRegion,
        maxAttempts: 5,
        retryMode: 'adaptive'
      });
      this.dynamoDb = DynamoDBDocument.from(dynamoDbClient);

      // Validate contract addresses
      if (!isAddress(config.nftContractAddress)) {
        throw new Error(`Invalid NFT contract address: ${config.nftContractAddress}`);
      }

      this.logger.info('Contract addresses validated successfully');
      this.logger.info('Attempting to connect to WebSocket provider', { 
        url: config.wsRpcUrl,
        providedNFTAddress: config.nftContractAddress
      });
      
      // Initialize Kinesis client with detailed logging
      this.logger.info('Initializing Kinesis client', {
        region: config.awsRegion,
        streamName: config.kinesisStreamName
      });
      
      this.kinesis = new KinesisClient({ 
        region: config.awsRegion,
        maxAttempts: 3,
        retryMode: 'standard'
      });

      // Initialize event handlers with required clients
      initializeHandlers(this.kinesis, dynamoDbClient, config);
      this.logger.info('Event handlers initialized with Kinesis and DynamoDB clients');
      
      // Initialize WebSocket connection
      this.initializeWebSocket();

    } catch (error) {
      this.logger.error('Failed to initialize event listener', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: ++this.reconnectAttempts
      });
      throw error;
    }
  }

  async start() {
    try {
      // Start heartbeat
      this.startHeartbeat();
      
      this.logger.info('Event listener started successfully');
    } catch (error) {
      this.logger.error('Failed to start event listener', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
      throw error;
    }
  }

  private async initializeWebSocket() {
    try {
      this.wsInitializing = true;
      this.logger.info('Initializing WebSocket connection', {
        url: this.config.wsRpcUrl,
        attempt: this.reconnectAttempts + 1
      });

      // Initialize provider with a dummy WebSocket first
      this.provider = new WebSocketProvider(
        () => new WebSocket(this.config.wsRpcUrl),
        "base",
        { staticNetwork: true, batchMaxCount: 1 }
      );

      this.nftContract = new Contract(this.config.nftContractAddress, EVENT_ABIS, this.provider);

      // Set up event listeners
      this.nftContract.on('BatchMint', async (event: any) => {
        this.logger.info('BatchMint event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        await this.handleEvent(event);
      });

      this.nftContract.on('BatchBurn', async (event: any) => {
        this.logger.info('BatchBurn event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          from: event.args?.from,
          startTokenId: Number(event.args?.startTokenId),
          quantity: Number(event.args?.quantity)
        });
        await this.handleEvent(event);
      });

      this.nftContract.on('BatchTransfer', async (event: any) => {
        this.logger.info('BatchTransfer event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          from: event.args?.from,
          to: event.args?.to,
          startTokenId: Number(event.args?.startTokenId),
          quantity: Number(event.args?.quantity)
        });
        await this.handleEvent(event);
      });

      this.nftContract.on('Stake', async (event: any) => {
        this.logger.info('Stake event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        await this.handleEvent(event);
      });

      this.nftContract.on('Unstake', async (event: any) => {
        this.logger.info('Unstake event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        });
        await this.handleEvent(event);
      });

      this.logger.info('Successfully subscribed to contract events', {
        subscribedEvents: ['BatchMint', 'BatchBurn', 'BatchTransfer', 'Stake', 'Unstake']
      });
      
      // Start heartbeat
      this.startHeartbeat();
      
      updateMetrics.updateWebsocket({
        connected: true,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: this.reconnectAttempts,
        circuitBreakerOpen: this.isCircuitBreakerOpen
      });

    } catch (error) {
      this.logger.error('Failed to initialize WebSocket', {
        error: error instanceof Error ? error.message : 'Unknown error',
        reconnectAttempts: this.reconnectAttempts
      });
      this.wsInitializing = false;
      this.reconnectAttempts++;
      this.reconnect();
    }
  }

  private cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    
    if (this.provider) {
      this.provider.destroy();
    }
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.provider && this.provider.websocket instanceof WebSocket) {
        const ws = this.provider.websocket;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, 30000); // Send ping every 30 seconds
  }

  private async handleEvent(event: any) {
    try {
      const eventId = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;
      const env = process.env.NODE_ENV || 'dev';
      const tableSuffix = env === 'prod' ? '-prod-v5' : '';
      const tableName = `${this.config.kinesisStreamName}${tableSuffix}-events`;
      
      // Check if event has already been processed
      try {
        const existingEvent = await this.dynamoDb.get({
          TableName: tableName,
          Key: { eventId }
        });

        if (existingEvent.Item) {
          this.logger.info('Event already processed, skipping', { 
            eventId,
            tableName 
          });
          return;
        }
      } catch (error: any) {
        if (error?.name === 'AccessDeniedException') {
          this.logger.error('DynamoDB access denied', {
            tableName,
            error: error.message,
            action: 'GetItem'
          });
        }
        throw error;
      }

      // Create the appropriate event payload based on event type
      let eventPayload: OnChainEvent;
      const receipt = await event.getTransactionReceipt();
      const block = await event.getBlock();

      switch (event.fragment.name) {
        case 'BatchMint': {
          const [to, startTokenId, quantity] = event.args;
          eventPayload = {
            type: 'BatchMint',
            to: to.toLowerCase(),
            startTokenId: Number(startTokenId),
            quantity: Number(quantity),
            timestamp: block.timestamp,
            transactionHash: event.transactionHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            logIndex: event.index.toString(16)
          } as BatchMintEvent;
          await handleBatchMint(eventPayload, this.logger);
          break;
        }
        case 'BatchBurn': {
          const [from, startTokenId, quantity] = event.args;
          eventPayload = {
            type: 'BatchBurn',
            from: from.toLowerCase(),
            startTokenId: Number(startTokenId),
            quantity: Number(quantity),
            timestamp: block.timestamp,
            transactionHash: event.transactionHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            logIndex: event.index.toString(16)
          } as BatchBurnEvent;
          await handleBatchBurn(eventPayload, this.logger);
          break;
        }
        case 'BatchTransfer': {
          const [from, to, startTokenId, quantity] = event.args;
          eventPayload = {
            type: 'BatchTransfer',
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            startTokenId: Number(startTokenId),
            quantity: Number(quantity),
            timestamp: block.timestamp,
            transactionHash: event.transactionHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            logIndex: event.index.toString(16)
          } as BatchTransferEvent;
          await handleBatchTransfer(eventPayload, this.logger);
          break;
        }
        case 'Stake': {
          const [account, tokenId] = event.args;
          eventPayload = {
            type: 'Stake',
            account: account.toLowerCase(),
            tokenId: Number(tokenId),
            timestamp: block.timestamp,
            transactionHash: event.transactionHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            logIndex: event.index.toString(16)
          } as StakeEvent;
          await handleStake(eventPayload, this.logger);
          break;
        }
        case 'Unstake': {
          const [account, tokenId] = event.args;
          eventPayload = {
            type: 'Unstake',
            account: account.toLowerCase(),
            tokenId: Number(tokenId),
            timestamp: block.timestamp,
            transactionHash: event.transactionHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index,
            logIndex: event.index.toString(16)
          } as UnstakeEvent;
          await handleUnstake(eventPayload, this.logger);
          break;
        }
        default: {
          this.logger.warn('Unknown event type received', {
            eventName: event.fragment.name,
            eventId
          });
          return;
        }
      }

      // Send to Kinesis
      const result = await this.kinesis.send(new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        Data: Buffer.from(JSON.stringify(eventPayload)),
        PartitionKey: eventId
      }));

      this.logger.info('Event sent to Kinesis', {
        eventId,
        eventType: eventPayload.type,
        shardId: result.ShardId,
        sequenceNumber: result.SequenceNumber
      });

      // Store event ID in DynamoDB for deduplication
      try {
        await this.dynamoDb.put({
          TableName: tableName,
          Item: {
            eventId,
            eventType: eventPayload.type,
            processedAt: Date.now(),
            ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour TTL
          }
        });
      } catch (error: any) {
        if (error?.name === 'AccessDeniedException') {
          this.logger.error('DynamoDB access denied', {
            tableName,
            error: error.message,
            action: 'PutItem'
          });
        }
        throw error;
      }

      this.logger.info('Event processed successfully', {
        eventId,
        eventType: eventPayload.type
      });
    } catch (error) {
      this.logger.error('Failed to process event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        event: {
          type: event.fragment?.name,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          args: event.args ? Array.from(event.args).map(arg => 
            typeof arg === 'bigint' ? arg.toString() : arg
          ) : []
        }
      });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping event listener');
    
    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    await this.provider.destroy();
    updateMetrics.updateWebsocket({
      connected: false
    });
  }

  private async reconnect(): Promise<void> {
    if (this.wsInitializing) {
      this.logger.info('WebSocket initialization already in progress, skipping reconnect');
      return;
    }

    if (this.isCircuitBreakerOpen) {
      if (Date.now() - this.lastCircuitBreakerReset > this.circuitBreakerTimeout) {
        this.logger.info('Circuit breaker timeout elapsed, resetting circuit breaker', {
          timeout: this.circuitBreakerTimeout,
          lastReset: this.lastCircuitBreakerReset
        });
        this.isCircuitBreakerOpen = false;
        this.reconnectAttempts = 0;
        this.lastCircuitBreakerReset = Date.now();
      } else {
        this.logger.warn('Circuit breaker is open, skipping reconnection attempt', {
          timeUntilReset: this.circuitBreakerTimeout - (Date.now() - this.lastCircuitBreakerReset)
        });
        return;
      }
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached, opening circuit breaker', {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      });
      this.isCircuitBreakerOpen = true;
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: this.reconnectAttempts,
        circuitBreakerOpen: true
      });
      
      // Instead of exiting, sleep for a longer period
      const cooldownPeriod = 300000; // 5 minutes
      this.logger.info(`Entering cooldown period for ${cooldownPeriod}ms`);
      await new Promise(resolve => setTimeout(resolve, cooldownPeriod));
      
      // Reset reconnection attempts and try again
      this.reconnectAttempts = 0;
      this.isCircuitBreakerOpen = false;
      this.lastCircuitBreakerReset = Date.now();
      return this.reconnect();
    }

    // Exponential backoff with jitter for rate limiting
    const baseDelay = this.baseReconnectDelay;
    const maxDelay = this.maxReconnectDelay;
    const attempt = this.reconnectAttempts;
    
    // Calculate delay with full jitter
    const expDelay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
    const delay = Math.floor(Math.random() * expDelay);

    this.logger.info('Attempting to reconnect', {
      attempt: attempt + 1,
      calculatedDelay: expDelay,
      actualDelay: delay,
      maxAttempts: this.maxReconnectAttempts,
      baseDelay: this.baseReconnectDelay
    });

    await new Promise(resolve => setTimeout(resolve, delay));
    this.initializeWebSocket();
  }
} 