import { WebSocketProvider, Contract, EventLog, id, Fragment, EventFragment } from 'ethers';
import WebSocket from 'ws';
import { KinesisClient, PutRecordCommand, DescribeStreamCommand, RegisterStreamConsumerCommand, DescribeStreamConsumerCommand, ConsumerStatus, ListStreamConsumersCommand, DeregisterStreamConsumerCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Config } from './types/config.js';
import type { OnChainEvent, BatchMintEvent, BatchBurnEvent, BatchTransferEvent, StakeEvent, UnstakeEvent } from './types/events.js';
import { Logger } from './utils/logger.js';
import { MetricsPublisher } from './utils/metrics.js';
import { updateMetrics, metrics } from './run.js';
import * as ethers from 'ethers';
import { handleBatchMint, handleBatchBurn, handleBatchTransfer, handleStake, handleUnstake, initializeHandlers } from './eventHandlers';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event BatchMint(address indexed to, uint256 startTokenId, uint256 quantity)',
  'event BatchBurn(address indexed from, uint256 startTokenId, uint256 quantity)',
  'event BatchTransfer(address indexed from, address indexed to, uint256 startTokenId, uint256 quantity)',
  'event Stake(address indexed account, uint256 tokenId)',
  'event Unstake(address indexed account, uint256 tokenId)'
];
// Old events that worked - just in case. 
// 'event BatchMint(address indexed to, uint256 startTokenId, uint256 quantity)',
// 'event BatchBurn(address indexed from, uint256 startTokenId, uint256 quantity)',
// 'event BatchTransfer(address indexed from, address indexed to, uint256[] tokenIds)',
// 'event Stake(address indexed account, uint256 tokenId)',
// 'event Unstake(address indexed account, uint256 tokenId)'
// and old batch transfer signature
// 0x7d85d6b5c6c9a5b7f36a6d1a5d76c71f44c8a24e3e0b03f9d0fd76520fac7db1

// Known signatures from the contract for validation
const KNOWN_SIGNATURES = {
  BatchMint: '0x63232c37f2c1fdcb4fc657df1cef6cabc7181c5b604530242590ffe5fa91ab74',
  BatchBurn: '0xc72888b04eef48850058b96e06db799bbca4b5511d5bd54d375af532446c7496',
  BatchTransfer: '0xe33fa6b1dc0e64c45482249b300e8b7a8c335905802467c723315913c6ff3911',
  Stake: '0x449a52f80565d07a38a3ae3a9ca18db7e54d645a1e6a4a89a2320e8c907eab3c',
  Unstake: '0x1381d2e30e0666d3e48b8a3c81e3c1f8f95c5bf76b4d6c0d2c5f63e742dbd1c5'
};

// ERC20 Transfer event signature - used to identify and ignore this event
const ERC20_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Function to compute and verify event signatures
function computeEventSignatures() {
  const computedSignatures = EVENT_ABIS.reduce((acc, eventAbi) => {
    const fragment = Fragment.from(eventAbi) as EventFragment;
    const signature = id(fragment.format());
    const eventName = fragment.name;
    acc[eventName] = signature;
    return acc;
  }, {} as Record<string, string>);

  // Compare with known signatures
  console.log('Event Signature Verification:');
  console.log('=============================');
  Object.entries(computedSignatures).forEach(([eventName, computedSig]) => {
    const knownSig = KNOWN_SIGNATURES[eventName as keyof typeof KNOWN_SIGNATURES];
    console.log(`Event: ${eventName}`);
    console.log(`Computed: ${computedSig}`);
    console.log(`Known:    ${knownSig}`);
    console.log(`Match:    ${computedSig === knownSig}`);
    console.log('-----------------------------');
  });

  return computedSignatures;
}

export class EventListener {
  private readonly config: Config;
  private readonly logger: Logger;
  private ws?: WebSocket;
  private provider!: WebSocketProvider;
  private nftContract!: Contract;
  private reconnectAttempts: number = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private maxReconnectAttempts: number = parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS || '10');
  private baseReconnectDelay: number = parseInt(process.env.WS_RECONNECT_DELAY || '1000');
  private maxReconnectDelay: number = 300000; // 5 minutes
  private circuitBreakerTimeout: number = parseInt(process.env.WS_CIRCUIT_BREAKER_TIMEOUT || '600000');
  private lastCircuitBreakerReset: number = Date.now();
  private isCircuitBreakerOpen: boolean = false;
  private wsInitializing: boolean = false;
  private kinesis: KinesisClient;
  private metrics: MetricsPublisher;
  private dynamoDb: DynamoDBDocument;
  private consumerId?: string;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('EventListener');
    
    try {
      this.logger.info('Starting event listener with config', {
        nftContractAddress: config.nftContractAddress,
        wsRpcUrl: config.wsRpcUrl,
        kinesisStreamName: config.kinesisStreamName,
        wsConfig: {
          maxReconnectAttempts: this.maxReconnectAttempts,
          baseReconnectDelay: this.baseReconnectDelay,
          circuitBreakerTimeout: this.circuitBreakerTimeout
        }
      });

      // Initialize DynamoDB client
      const dynamoDbClient = new DynamoDBClient({ region: config.awsRegion });
      this.dynamoDb = DynamoDBDocument.from(dynamoDbClient);

      // Validate contract addresses
      if (!ethers.isAddress(config.nftContractAddress)) {
        throw new Error(`Invalid NFT contract address: ${config.nftContractAddress}`);
      }

      this.logger.info('Contract addresses validated successfully');
      this.logger.info('Attempting to connect to WebSocket provider', { 
        url: config.wsRpcUrl,
        providedNFTAddress: config.nftContractAddress
      });
      
      this.initializeWebSocket();
      
      this.nftContract = new Contract(config.nftContractAddress, EVENT_ABIS, this.provider);
      
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
      initializeHandlers(this.kinesis, this.dynamoDb, config);
      this.logger.info('Event handlers initialized with Kinesis and DynamoDB clients');
      
      // Verify event signatures
      const computedSignatures = computeEventSignatures();
      this.logger.info('Event signature verification', {
        signatures: Object.entries(computedSignatures).map(([name, sig]) => ({
          event: name,
          computed: sig,
          known: KNOWN_SIGNATURES[name as keyof typeof KNOWN_SIGNATURES],
          matches: sig === KNOWN_SIGNATURES[name as keyof typeof KNOWN_SIGNATURES]
        }))
      });
      
      // Log Kinesis configuration without credentials for now
      this.logger.info('Kinesis client initialized', {
        clientConfig: {
          region: this.kinesis.config.region,
          maxAttempts: 3,
          retryMode: 'standard'
        }
      });
      
      this.metrics = new MetricsPublisher(config.awsRegion, 'NGU/BlockchainEvents');
      
      // Validate computed signatures against known signatures
      this.logger.info('Validating event signatures', {
        nftEvents: this.nftContract.interface.fragments
          .filter((f): f is EventFragment => f.type === 'event')
          .map(event => ({
            name: event.name,
            format: event.format(),
            computedSignature: id(event.format()),
            knownSignature: KNOWN_SIGNATURES[event.name as keyof typeof KNOWN_SIGNATURES],
            matches: id(event.format()) === KNOWN_SIGNATURES[event.name as keyof typeof KNOWN_SIGNATURES]
          }))
      });

      this.logger.info('Contracts initialized', {
        nftAddress: this.nftContract.target
      });
    } catch (error) {
      this.logger.error('Failed to initialize WebSocket provider', { error });
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
      // Verify Kinesis stream access
      const describeCommand = new DescribeStreamCommand({
        StreamName: this.config.kinesisStreamName
      });
      
      const streamDescription = await this.kinesis.send(describeCommand);
      this.logger.info('Successfully verified Kinesis stream access', {
        streamName: this.config.kinesisStreamName,
        streamStatus: streamDescription.StreamDescription?.StreamStatus,
        shardCount: streamDescription.StreamDescription?.Shards?.length
      });

      // Register as enhanced fan-out consumer
      await this.setupEnhancedFanOut();

      // Start heartbeat
      this.startHeartbeat();
      
      // Set up event listeners
      await this.setupEventListeners();
      
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

  private async setupEventListeners() {
    this.logger.info('🔄 SETUP: Starting event listener setup', {
      nftContractAddress: this.nftContract.target,
      wsUrl: this.config.wsRpcUrl
    });

    // Verify provider connection
    try {
      const network = await this.provider.getNetwork();
      this.logger.info('✅ WEBSOCKET: Connected to network', {
        chainId: network.chainId,
        name: network.name
      });

      // Test provider by getting latest block
      const block = await this.provider.getBlock('latest');
      this.logger.info('✅ WEBSOCKET: Retrieved latest block', {
        blockNumber: block?.number,
        timestamp: block?.timestamp,
        hash: block?.hash
      });
    } catch (error) {
      this.logger.error('❌ WEBSOCKET: Failed to verify provider connection', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
      throw error;
    }

    // Verify contract interfaces
    try {
      this.logger.info('🔄 SETUP: Verifying contract interfaces', {
        nftEvents: EVENT_ABIS,
        nftAddress: this.nftContract.target
      });

      // Create and verify filters for each event type
      const eventTypes = ['BatchMint', 'BatchBurn', 'BatchTransfer'];
      for (const eventType of eventTypes) {
        try {
          const filter = this.nftContract.filters[eventType]();
          const topics = await this.provider.getNetwork().then(() => {
            const filterTopics = filter instanceof Object && 'getTopicFilter' in filter 
              ? filter.getTopicFilter()
              : [];
            return filterTopics;
          });
          
          this.logger.info('🔍 FILTER: Created event filter', {
            eventType,
            topics,
            filterConfig: {
              contractAddress: this.nftContract.target,
              topics
            }
          });

          // Test the filter with a query
          const testEvents = await this.nftContract.queryFilter(filter, -1000);
          this.logger.info('✅ FILTER: Tested event filter', {
            eventType,
            recentEventsCount: testEvents.length,
            lastEventBlock: testEvents[testEvents.length - 1]?.blockNumber,
            hasValidFilter: !!topics.length
          });
        } catch (error) {
          this.logger.error('❌ FILTER: Failed to create or test filter', {
            eventType,
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack
            } : error
          });
        }
      }

      // Log the events we're listening for with their signatures
      const nftEvents = this.nftContract.interface.fragments
        .filter((f): f is EventFragment => f.type === 'event')
        .map(event => ({
          name: event.name,
          signature: event.format(),
          topics: [id(event.format())],
          knownSignature: KNOWN_SIGNATURES[event.name as keyof typeof KNOWN_SIGNATURES],
          signatureMatch: id(event.format()) === KNOWN_SIGNATURES[event.name as keyof typeof KNOWN_SIGNATURES]
        }));

      this.logger.info('📋 SETUP: Event signatures verification', {
        events: nftEvents,
        validSignatures: nftEvents.every(e => e.signatureMatch)
      });

      // Subscribe to new blocks for heartbeat and verify subscription
      let blockReceived = false;
      const blockTimeout = setTimeout(() => {
        if (!blockReceived) {
          this.logger.warn('⚠️ WEBSOCKET: No blocks received within 30 seconds of setup');
        }
      }, 30000);

      this.provider.on('block', async (blockNumber) => {
        if (!blockReceived) {
          blockReceived = true;
          clearTimeout(blockTimeout);
          this.logger.info('✅ WEBSOCKET: First block received', { blockNumber });
        }

        try {
          // Get block details
          const block = await this.provider.getBlock(blockNumber);
          if (!block) return;

          // Get all events in this block for our contracts
          this.logger.info('🔍 DEBUG: Querying events for block', { 
            blockNumber,
            contractAddress: this.nftContract.target
          });

          const events = await this.nftContract.queryFilter('*' as any, block.number, block.number);
          
          // Log raw events for debugging
          if (events.length > 0) {
            this.logger.info('🔍 DEBUG: Raw events found in block', {
              blockNumber,
              eventCount: events.length,
              events: events.map(event => ({
                name: event instanceof EventLog ? event.fragment?.name : 'unknown',
                topics: event.topics,
                data: event.data,
                address: event.address
              }))
            });
          }

          // Only log if we found relevant events
          if (events.length > 0) {
            // Count events by type, ensuring we handle the event data safely
            const eventCounts = events.reduce((acc: Record<string, number>, event) => {
              let eventName = 'unknown';
              
              try {
                // Check if it's an EventLog
                if ('fragment' in event && event.fragment?.name) {
                  eventName = event.fragment.name;
                  
                  this.logger.info('🔍 DEBUG: Processing event', {
                    eventName,
                    eventFragment: event.fragment.format(),
                    eventSignature: id(event.fragment.format()),
                    knownSignature: KNOWN_SIGNATURES[eventName as keyof typeof KNOWN_SIGNATURES],
                    args: event.args ? Array.from(event.args).map(arg => 
                      typeof arg === 'bigint' ? arg.toString() : arg
                    ) : []
                  });
                  
                } else if (event.topics?.[0]) {
                  // Skip ERC20 Transfer events
                  if (event.topics[0] === ERC20_TRANSFER_SIGNATURE) {
                    this.logger.info('Skipping ERC20 Transfer event', {
                      topic: event.topics[0]
                    });
                    return acc;
                  }
                  
                  // Try to match the topic signature
                  const matchedEvent = Object.entries(KNOWN_SIGNATURES)
                    .find(([_, sig]) => sig === event.topics[0]);
                  if (matchedEvent) {
                    eventName = matchedEvent[0];
                    this.logger.info('🔍 DEBUG: Matched event by topic', {
                      eventName,
                      topic: event.topics[0]
                    });

                    // Decode and process the matched event
                    try {
                      const decodedEvent = this.nftContract.interface.parseLog({
                        topics: event.topics,
                        data: event.data
                      });

                      if (decodedEvent) {
                        const processEvent = async () => {
                          const receipt = await event.getTransactionReceipt();
                          const block = await event.getBlock();

                          switch (eventName) {
                            case 'BatchMint': {
                              const [to, startTokenId, quantity] = decodedEvent.args;
                              this.logger.info('🔍 DEBUG: About to create BatchMint event payload', {
                                to,
                                startTokenId: Number(startTokenId),
                                quantity: Number(quantity)
                              });
                              const eventPayload: BatchMintEvent = {
                                type: 'BatchMint',
                                to: to.toLowerCase(),
                                startTokenId: Number(startTokenId),
                                quantity: Number(quantity),
                                timestamp: block.timestamp,
                                transactionHash: event.transactionHash,
                                blockNumber: receipt.blockNumber,
                                transactionIndex: receipt.index,
                                logIndex: event.index.toString(16)
                              };
                              this.logger.info('🔍 DEBUG: Created BatchMint event payload, about to process', {
                                payload: eventPayload
                              });
                              await this.handleEvent(eventPayload);
                              this.logger.info('🔍 DEBUG: BatchMint event processing completed');
                            }
                            break;

                            case 'BatchBurn': {
                              const [from, startTokenId, quantity] = decodedEvent.args;
                              const eventPayload: BatchBurnEvent = {
                                type: 'BatchBurn',
                                from: from.toLowerCase(),
                                startTokenId: Number(startTokenId),
                                quantity: Number(quantity),
                                timestamp: block.timestamp,
                                transactionHash: event.transactionHash,
                                blockNumber: receipt.blockNumber,
                                transactionIndex: receipt.index,
                                logIndex: event.index.toString(16)
                              };
                              await handleBatchBurn(eventPayload, this.logger);
                              await this.handleEvent(eventPayload);
                            }
                            break;

                            case 'BatchTransfer': {
                              const [from, to, startTokenId, quantity] = decodedEvent.args;
                              const eventPayload: BatchTransferEvent = {
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
                              };
                              await handleBatchTransfer(eventPayload, this.logger);
                              await this.handleEvent(eventPayload);
                            }
                            break;

                            case 'Stake': {
                              const [account, tokenId] = decodedEvent.args;
                              const eventPayload: StakeEvent = {
                                type: 'Stake',
                                account: account.toLowerCase(),
                                tokenId: Number(tokenId),
                                timestamp: block.timestamp,
                                transactionHash: event.transactionHash,
                                blockNumber: receipt.blockNumber,
                                transactionIndex: receipt.index,
                                logIndex: event.index.toString(16)
                              };
                              await handleStake(eventPayload, this.logger);
                              await this.handleEvent(eventPayload);
                            }
                            break;

                            case 'Unstake': {
                              const [account, tokenId] = decodedEvent.args;
                              const eventPayload: UnstakeEvent = {
                                type: 'Unstake',
                                account: account.toLowerCase(),
                                tokenId: Number(tokenId),
                                timestamp: block.timestamp,
                                transactionHash: event.transactionHash,
                                blockNumber: receipt.blockNumber,
                                transactionIndex: receipt.index,
                                logIndex: event.index.toString(16)
                              };
                              await handleUnstake(eventPayload, this.logger);
                              await this.handleEvent(eventPayload);
                            }
                            break;
                          }
                        };

                        // Execute the async function
                        processEvent().catch(error => {
                          this.logger.error('Error processing event', {
                            error: error instanceof Error ? {
                              message: error.message,
                              stack: error.stack
                            } : error,
                            eventName,
                            eventData: {
                              topics: event.topics,
                              data: event.data,
                              address: event.address
                            }
                          });
                        });
                      }
                    } catch (error) {
                      this.logger.error('Error processing decoded event', {
                        error: error instanceof Error ? {
                          message: error.message,
                          stack: error.stack
                        } : error,
                        eventName,
                        eventData: {
                          topics: event.topics,
                          data: event.data,
                          address: event.address
                        }
                      });
                    }
                  } else {
                    this.logger.warn('⚠️ Unknown event topic', {
                      topic: event.topics[0],
                      knownSignatures: KNOWN_SIGNATURES
                    });
                  }
                }
              } catch (error) {
                this.logger.error('Error processing event in block', {
                  error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack
                  } : error,
                  eventType: eventName,
                  blockNumber: block.number,
                  eventData: event
                });
              }
              
              acc[eventName] = (acc[eventName] || 0) + 1;
              return acc;
            }, {});

            // Only log if we found known events
            const knownEvents = Object.keys(eventCounts).filter(name => name !== 'unknown');
            if (knownEvents.length > 1) {
              this.logger.info('📥 WEBSOCKET: Multiple events in block', { 
                blockNumber,
                timestamp: block.timestamp,
                events: knownEvents.map(name => ({
                  type: name,
                  count: eventCounts[name]
                }))
              });
            }
          }

          updateMetrics.updateWebsocket({
            connected: true,
            messagesProcessed: metrics.websocket.messagesProcessed + 1
          });
        } catch (error) {
          this.logger.error('❌ Error processing block events', {
            blockNumber,
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack
            } : error
          });
        }
      });

    } catch (error) {
      this.logger.error('❌ SETUP: Failed to verify contract interfaces', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
      throw error;
    }

    // Add provider-level error handling
    this.provider.on('error', (error) => {
      this.logger.error('❌ WEBSOCKET: Provider error', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error 
      });
      updateMetrics.updateWebsocket({
        connected: false,
        messagesProcessed: 0
      });
    });

    // Update metrics with error count
    updateMetrics.updateWebsocket({
      connected: false,
      lastReconnectAttempt: Date.now(),
      reconnectAttempts: this.reconnectAttempts
    });

    // Add provider-level error handling
    if ('websocket' in this.provider && this.provider.websocket instanceof WebSocket) {
      const ws = this.provider.websocket;
      
      ws.addEventListener('close', () => {
        this.logger.warn('⚠️ WEBSOCKET: Connection closed', {
          timestamp: new Date().toISOString()
        });
        updateMetrics.updateWebsocket({
          connected: false
        });
      });

      ws.addEventListener('open', () => {
        this.logger.info('✅ WEBSOCKET: Connection opened', {
          timestamp: new Date().toISOString()
        });
        updateMetrics.updateWebsocket({
          connected: true
        });
      });
    }

    // Test event subscription by querying past events
    try {
      const filter = this.nftContract.filters.BatchTransfer();
      const pastEvents = await this.nftContract.queryFilter(filter, -10000); // Last 10000 blocks
      this.logger.info('📋 SETUP: Past events query test', {
        eventCount: pastEvents.length,
        oldestBlock: pastEvents[0]?.blockNumber,
        newestBlock: pastEvents[pastEvents.length - 1]?.blockNumber
      });
    } catch (error) {
      this.logger.error('❌ SETUP: Failed to query past events', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
    }

    this.logger.info('✅ SETUP: Event listeners setup complete', {
      nftContractAddress: this.nftContract.target,
      wsUrl: this.config.wsRpcUrl
    });
  }

  private async handleEvent(event: any) {
    try {
      const eventId = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;
      
      // Check if event has already been processed
      const existingEvent = await this.dynamoDb.get({
        TableName: `${this.config.kinesisStreamName}-events`,
        Key: { eventId }
      });

      if (existingEvent.Item) {
        this.logger.info('Event already processed, skipping', { eventId });
        return;
      }

      // Enrich event data
      const enrichedEvent = {
        ...event,
        eventId,
        timestamp: Date.now(),
        environment: this.config.environment
      };

      // Send to Kinesis
      const result = await this.kinesis.send(new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        Data: Buffer.from(JSON.stringify(enrichedEvent)),
        PartitionKey: eventId
      }));

      this.logger.info('Event sent to Kinesis', {
        eventId,
        shardId: result.ShardId,
        sequenceNumber: result.SequenceNumber
      });

      // Store event ID in DynamoDB for deduplication
      await this.dynamoDb.put({
        TableName: `${this.config.kinesisStreamName}-events`,
        Item: {
          eventId,
          processedAt: Date.now(),
          ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour TTL
        }
      });

      this.logger.info('Event processed successfully', { eventId });
    } catch (error) {
      this.logger.error('Failed to process event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        event
      });
      throw error;
    }
  }

  private async monitorConnection() {
    const ws = this.provider.websocket as WebSocket;
    
    ws.on('close', async () => {
      this.logger.info('WebSocket connection closed');
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now()
      });
      await this.reconnect();
    });

    ws.on('error', (error: WebSocket.ErrorEvent) => {
      this.logger.error('WebSocket connection error', error);
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: ++this.reconnectAttempts
      });
    });
  }

  private async reconnect() {
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
      // Exit the process to let systemd restart it
      process.exit(1);
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.logger.info('Attempting to reconnect', {
      attempt: this.reconnectAttempts + 1,
      delay,
      maxAttempts: this.maxReconnectAttempts,
      baseDelay: this.baseReconnectDelay
    });

    await new Promise(resolve => setTimeout(resolve, delay));
    this.initializeWebSocket();
  }

  private createWebSocketProvider() {
    return () => {
      const ws = new WebSocket(this.config.wsRpcUrl, {
        handshakeTimeout: 5000,
        maxPayload: 100 * 1024 * 1024 // 100MB
      });
      
      ws.onopen = () => {
        this.logger.info('🌟 WEBSOCKET: Connection established', {
          readyState: ws.readyState,
          url: this.config.wsRpcUrl,
          timestamp: new Date().toISOString()
        });
        updateMetrics.updateWebsocket({
          connected: true,
          lastReconnectAttempt: Date.now()
        });
      };
      
      ws.onerror = (error: WebSocket.ErrorEvent) => {
        this.logger.error('❌ WEBSOCKET: Connection error', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            type: error.type,
            code: (error as any).code
          } : error,
          readyState: ws.readyState,
          url: this.config.wsRpcUrl
        });
        updateMetrics.updateWebsocket({
          connected: false,
          lastReconnectAttempt: Date.now(),
          reconnectAttempts: ++this.reconnectAttempts
        });
      };

      ws.onclose = (event) => {
        this.logger.error('❌ WEBSOCKET: Connection closed', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          readyState: ws.readyState,
          url: this.config.wsRpcUrl
        });
      };

      // Add message handler to log any server messages
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          this.logger.info('📥 WEBSOCKET: Received message', {
            data,
            type: event.type,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          this.logger.warn('⚠️ WEBSOCKET: Could not parse message', {
            raw: event.data.toString(),
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      };
      
      return ws;
    };
  }

  private startHeartbeat() {
    // Clear any existing heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(async () => {
      try {
        // Check if websocket is still connected
        const ws = this.provider.websocket as WebSocket;
        if (ws.readyState !== WebSocket.OPEN) {
          this.logger.error('WebSocket not open during heartbeat check', {
            readyState: ws.readyState
          });
          await this.reconnect();
          return;
        }

        // Send a ping frame
        ws.ping();

        // Update metrics
        updateMetrics.updateWebsocket({
          connected: true,
          messagesProcessed: metrics.websocket.messagesProcessed + 1
        });
      } catch (error) {
        this.logger.error('Heartbeat check failed', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error
        });
        await this.reconnect();
      }
    }, 30000); // 30 seconds
  }

  private async setupEnhancedFanOut() {
    try {
      const streamARN = `arn:aws:kinesis:${this.config.awsRegion}:${this.config.awsAccountId}:stream/${this.config.kinesisStreamName}`;
      
      // Generate a random suffix for the consumer name
      const randomSuffix = Math.random().toString(36).substring(2, 15);
      const consumerName = `ngu-event-listener-${this.config.environment}-${randomSuffix}`;
      this.consumerId = consumerName;

      this.logger.info('Setting up enhanced fan-out consumer', {
        streamName: this.config.kinesisStreamName,
        consumerName
      });

      // List and cleanup existing consumers
      const listCommand = new ListStreamConsumersCommand({
        StreamARN: streamARN
      });

      const existingConsumers = await this.kinesis.send(listCommand);
      
      // Delete any existing consumers that match our prefix
      if (existingConsumers.Consumers && existingConsumers.Consumers.length > 0) {
        this.logger.info('Found existing consumers', {
          count: existingConsumers.Consumers.length,
          consumers: existingConsumers.Consumers.map(c => c.ConsumerName)
        });

        const prefix = `ngu-event-listener-${this.config.environment}`;
        const deletePromises = existingConsumers.Consumers
          .filter(consumer => consumer.ConsumerName?.startsWith(prefix))
          .map(async consumer => {
            this.logger.info('Deregistering existing consumer', {
              consumerName: consumer.ConsumerName
            });
            
            try {
              const deregisterCommand = new DeregisterStreamConsumerCommand({
                StreamARN: streamARN,
                ConsumerName: consumer.ConsumerName
              });
              await this.kinesis.send(deregisterCommand);
              
              // Wait for deletion to complete
              await this.waitForConsumerDeletion(streamARN, consumer.ConsumerName!);
            } catch (error: any) {
              // Log but don't fail if we can't delete an old consumer
              this.logger.warn('Failed to deregister existing consumer', {
                consumerName: consumer.ConsumerName,
                error: error.message
              });
            }
          });

        await Promise.all(deletePromises);
      }

      // Register new consumer
      this.logger.info('Registering new consumer', { consumerName });
      const registerCommand = new RegisterStreamConsumerCommand({
        StreamARN: streamARN,
        ConsumerName: consumerName
      });

      const registerResponse = await this.kinesis.send(registerCommand);
      this.logger.info('Consumer registration initiated', {
        consumerName,
        arn: registerResponse.Consumer?.ConsumerARN
      });
      
      // Wait for new consumer to become active
      await this.waitForConsumerStatus(streamARN, consumerName, ConsumerStatus.ACTIVE);
      
      this.logger.info('Enhanced fan-out consumer setup complete', {
        consumerId: this.consumerId,
        arn: registerResponse.Consumer?.ConsumerARN
      });
    } catch (error) {
      this.logger.error('Failed to setup enhanced fan-out consumer', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error
      });
      throw error;
    }
  }

  // Helper method to wait for a specific consumer status
  private async waitForConsumerStatus(streamARN: string, consumerName: string, targetStatus: ConsumerStatus) {
    let attempts = 0;
    const maxAttempts = 30; // Increased from 10 to allow more time
    const waitTime = 2000; // 2 seconds between attempts

    while (attempts < maxAttempts) {
      try {
        const describeConsumer = new DescribeStreamConsumerCommand({
          StreamARN: streamARN,
          ConsumerName: consumerName
        });
        
        const description = await this.kinesis.send(describeConsumer);
        const currentStatus = description.ConsumerDescription?.ConsumerStatus;
        
        this.logger.info('Checking consumer status', {
          attempt: attempts + 1,
          currentStatus,
          targetStatus,
          consumerName
        });
        
        if (currentStatus === targetStatus) {
          this.logger.info('Consumer reached target status', {
            consumerName,
            status: targetStatus
          });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, waitTime));
        attempts++;
      } catch (error: any) {
        if (error.name === 'ResourceNotFoundException') {
          // If we're waiting for ACTIVE status and consumer doesn't exist, that's an error
          if (targetStatus === ConsumerStatus.ACTIVE) {
            throw new Error('Consumer not found while waiting for ACTIVE status');
          }
          // Otherwise (e.g., waiting for deletion), this is success
          return;
        }
        throw error;
      }
    }

    throw new Error(`Timeout waiting for consumer to reach status ${targetStatus}`);
  }

  // Helper method to wait for consumer deletion
  private async waitForConsumerDeletion(streamARN: string, consumerName: string) {
    return this.waitForConsumerStatus(streamARN, consumerName, ConsumerStatus.DELETING);
  }

  // Add cleanup method for consumer on shutdown
  private async cleanupConsumer(): Promise<void> {
    if (this.consumerId) {
      try {
        const streamARN = `arn:aws:kinesis:${this.config.awsRegion}:${this.config.awsAccountId}:stream/${this.config.kinesisStreamName}`;
        const deregisterCommand = new DeregisterStreamConsumerCommand({
          StreamARN: streamARN,
          ConsumerName: this.consumerId
        });
        await this.kinesis.send(deregisterCommand);
        this.logger.info('Successfully deregistered consumer on shutdown', {
          consumerId: this.consumerId
        });
      } catch (error: any) {
        // If the consumer doesn't exist, that's okay - log as warning
        if (error.name === 'ResourceNotFoundException' || error.message?.includes('not found')) {
          this.logger.warn('Consumer already deregistered or not found during shutdown', {
            consumerId: this.consumerId,
            error: error instanceof Error ? error.message : error
          });
        } else {
          // For other errors, log as error
          this.logger.error('Failed to deregister consumer on shutdown', {
            consumerId: this.consumerId,
            error: error instanceof Error ? error.message : error
          });
        }
      }
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping event listener');
    
    // Clean up consumer before stopping
    await this.cleanupConsumer();
    
    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    await this.provider.destroy();
    updateMetrics.updateWebsocket({
      connected: false
    });
  }

  private async initializeWebSocket() {
    try {
      this.wsInitializing = true;
      this.logger.info('Initializing WebSocket connection', {
        url: this.config.wsRpcUrl,
        attempt: this.reconnectAttempts + 1
      });

      if (this.ws) {
        this.logger.info('Cleaning up existing WebSocket connection');
        this.cleanup();
      }

      this.ws = new WebSocket(this.config.wsRpcUrl);

      this.ws.on('open', () => {
        this.logger.info('WebSocket connection established', {
          readyState: this.ws?.readyState,
          reconnectAttempts: this.reconnectAttempts
        });
        
        // Reset reconnection counter on successful connection
        this.reconnectAttempts = 0;
        this.wsInitializing = false;
        
        // Start heartbeat
        this.startHeartbeat();
        
        // Subscribe to events
        this.subscribeToEvents();
        
        updateMetrics.updateWebsocket({
          connected: true,
          lastReconnectAttempt: Date.now(),
          reconnectAttempts: this.reconnectAttempts,
          circuitBreakerOpen: this.isCircuitBreakerOpen
        });
      });

      this.ws.on('close', (code: number, reason: string) => {
        const wasClean = code === 1000;
        this.logger.warn('WebSocket connection closed', {
          code,
          reason: reason.toString(),
          wasClean,
          readyState: this.ws?.readyState
        });
        
        this.cleanup();
        this.wsInitializing = false;
        
        if (!wasClean) {
          this.reconnectAttempts++;
          this.reconnect();
        }
        
        updateMetrics.updateWebsocket({
          connected: false,
          lastReconnectAttempt: Date.now(),
          reconnectAttempts: this.reconnectAttempts,
          circuitBreakerOpen: this.isCircuitBreakerOpen
        });
      });

      this.ws.on('error', (error: Error) => {
        this.logger.error('WebSocket error occurred', {
          error: error.message,
          readyState: this.ws?.readyState,
          reconnectAttempts: this.reconnectAttempts
        });
        
        // Let the close handler handle reconnection
        this.cleanup();
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
    
    if (this.ws) {
      // Remove all listeners to prevent memory leaks
      this.ws.removeAllListeners();
      
      // Close connection if it's still open
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Cleanup initiated');
      }
      
      this.ws = undefined;
    }
  }

  private async subscribeToEvents() {
    try {
      // Subscribe to contract events
      this.nftContract.on('BatchMint', async (event: any) => {
        this.logger.info('BatchMint event received', {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
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

      this.logger.info('Successfully subscribed to contract events');
    } catch (error) {
      this.logger.error('Failed to subscribe to events', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
} 