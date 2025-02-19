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
      const tokensTableName = env === 'prod' ? 'ngu-points-core-v5-tokens-prod' : 'ngu-points-core-v5-tokens';
      const pointsTableName = env === 'prod' ? 'ngu-points-core-v5-points-prod' : 'ngu-points-core-v5-points';
      
      this.logger.info('Starting event listener with config', {
        nftContractAddress: config.nftContractAddress,
        wsRpcUrl: config.wsRpcUrl,
        kinesisStreamName: config.kinesisStreamName,
        tokensTableName,
        pointsTableName,
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
        () => {
          const ws = new WebSocket(this.config.wsRpcUrl) as WebSocket & { on: Function };
          
          // Add error handler before connection
          ws.on('error', (error: any) => {
            if (error.message?.includes('429')) {
              this.logger.warn('Rate limit hit, increasing backoff', {
                attempt: this.reconnectAttempts,
                error: error.message
              });
              // Double the base delay on rate limit
              this.baseReconnectDelay = Math.min(this.maxReconnectDelay, this.baseReconnectDelay * 2);
            }
          });

          return ws;
        },
        "base",
        { 
          staticNetwork: true, 
          batchMaxCount: 1,
          // Disable automatic polling of new blocks
          polling: false
        }
      );

      // Add connection state handler
      if (this.provider.websocket) {
        (this.provider.websocket as WebSocket & { on: Function }).on('close', (code: number, reason: string) => {
          this.logger.warn('WebSocket connection closed', {
            code,
            reason: reason.toString(),
            attempt: this.reconnectAttempts
          });
          
          if (code === 429) {
            // Rate limited - increase backoff
            this.baseReconnectDelay = Math.min(this.maxReconnectDelay, this.baseReconnectDelay * 2);
          }
          
          this.cleanup();
          this.wsInitializing = false;
          this.reconnect();
        });
      }

      this.nftContract = new Contract(this.config.nftContractAddress, EVENT_ABIS, this.provider);

      // Get current block for starting point
      const currentBlock = await this.provider.getBlockNumber();
      
      // Set up event listeners for each event type
      const eventNames = EVENT_ABIS.map(abi => abi.split('event ')[1].split('(')[0]);
      
      for (const eventName of eventNames) {
        this.nftContract.on(eventName, async (...args: any[]) => {
          // The last argument is the event object
          const event = args[args.length - 1];
          
          this.logger.info(`${eventName} event received`, {
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            args: args.slice(0, -1).map(arg => 
              typeof arg === 'bigint' ? arg.toString() : arg
            )
          });
          
          await this.handleEvent(event);
        });
      }

      this.logger.info('Successfully subscribed to contract events', {
        subscribedEvents: eventNames,
        startingBlock: currentBlock
      });
      
      // Start heartbeat with longer interval
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
    }, 60000); // Increase ping interval to 60 seconds
  }

  private async handleEvent(event: any) {
    try {
      const env = process.env.NODE_ENV || 'dev';
      const tokensTableName = env === 'prod' ? 'ngu-points-core-v5-tokens-prod' : 'ngu-points-core-v5-tokens';
      const pointsTableName = env === 'prod' ? 'ngu-points-core-v5-points-prod' : 'ngu-points-core-v5-points';
      
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
            transactionHash: event.transactionHash
          });
          return;
        }
      }

      // Send to Kinesis for event streaming
      const result = await this.kinesis.send(new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        Data: Buffer.from(JSON.stringify(eventPayload)),
        PartitionKey: event.transactionHash
      }));

      this.logger.info('Event sent to Kinesis', {
        transactionHash: event.transactionHash,
        eventType: eventPayload.type,
        shardId: result.ShardId,
        sequenceNumber: result.SequenceNumber
      });

      // Update token ownership in DynamoDB
      if (['BatchMint', 'BatchTransfer', 'BatchBurn'].includes(eventPayload.type)) {
        try {
          // Token table updates will be handled by the specific event handlers
          // They will use the correct key schema (id: Number)
          this.logger.info('Token event processed', {
            transactionHash: event.transactionHash,
            eventType: eventPayload.type,
            table: tokensTableName
          });
        } catch (error: any) {
          if (error?.name === 'AccessDeniedException') {
            this.logger.error('DynamoDB access denied', {
              tableName: tokensTableName,
              error: error.message,
              action: 'UpdateItem'
            });
          }
          throw error;
        }
      }

      // Update points in DynamoDB
      if (['Stake', 'Unstake'].includes(eventPayload.type)) {
        try {
          // Points updates will be handled by the specific event handlers
          // They will use the correct key schema (address: String)
          this.logger.info('Points event processed', {
            transactionHash: event.transactionHash,
            eventType: eventPayload.type,
            table: pointsTableName
          });
        } catch (error: any) {
          if (error?.name === 'AccessDeniedException') {
            this.logger.error('DynamoDB access denied', {
              tableName: pointsTableName,
              error: error.message,
              action: 'UpdateItem'
            });
          }
          throw error;
        }
      }

      this.logger.info('Event processed successfully', {
        transactionHash: event.transactionHash,
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
        // Reset base delay when circuit breaker resets
        this.baseReconnectDelay = parseInt(process.env.WS_RECONNECT_DELAY || '5000');
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
      this.logger.info(`Entering cooldown period for ${cooldownPeriod}ms`, {
        baseDelay: this.baseReconnectDelay,
        attempts: this.reconnectAttempts
      });
      await new Promise(resolve => setTimeout(resolve, cooldownPeriod));
      
      // Reset reconnection attempts and try again
      this.reconnectAttempts = 0;
      this.isCircuitBreakerOpen = false;
      this.lastCircuitBreakerReset = Date.now();
      // Reset base delay after cooldown
      this.baseReconnectDelay = parseInt(process.env.WS_RECONNECT_DELAY || '5000');
      return this.reconnect();
    }

    // Exponential backoff with full jitter for rate limiting
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
      baseDelay: this.baseReconnectDelay,
      currentMaxDelay: maxDelay
    });

    await new Promise(resolve => setTimeout(resolve, delay));
    this.initializeWebSocket();
  }
} 