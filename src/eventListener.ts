import { WebSocketProvider, Contract, EventLog, id, Fragment, EventFragment } from 'ethers';
import WebSocket from 'ws';
import { KinesisClient, PutRecordCommand, DescribeStreamCommand, RegisterStreamConsumerCommand, DescribeStreamConsumerCommand, ConsumerStatus, ListStreamConsumersCommand, DeregisterStreamConsumerCommand } from '@aws-sdk/client-kinesis';
import type { Config } from './types/config.js';
import type { OnChainEvent } from './types/events.js';
import { Logger } from './utils/logger.js';
import { MetricsPublisher } from './utils/metrics.js';
import { updateMetrics, metrics } from './run.js';
import * as ethers from 'ethers';
import AWS from 'aws-sdk';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event BatchMint(address,uint256,uint256)',
  'event BatchBurn(address,uint256,uint256)',
  'event BatchTransfer(address,address,uint256,uint256)',
  'event Stake(address,uint256)',
  'event Unstake(address,uint256)'
];

// Known signatures from the contract for validation
const KNOWN_SIGNATURES = {
  BatchMint: '0x63232c37f2c1fdcb4fc657df1cef6cabc7181c5b604530242590ffe5fa91ab74',
  BatchBurn: '0xc72888b04eef48850058b96e06db799bbca4b5511d5bd54d375af532446c7496',
  BatchTransfer: '0xe33fa6b1dc0e64c45482249b300e8b7a8c335905802467c723315913c6ff3911',
  Stake: '0xebedb8b3c678666e7f36970bc8f57abf6d8fa2e828c0da91ea5b75bf68ed101a',
  Unstake: '0x85082129d87b2fe11527cb1b3b7a520aeb5aa6913f88a3d8757fe40d1db02fdd'
};

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
  private provider: WebSocketProvider;
  private nftContract: Contract;
  private kinesis: KinesisClient;
  private metrics: MetricsPublisher;
  private logger: Logger;
  private config: Config;
  private dynamoDb: AWS.DynamoDB.DocumentClient;
  private reconnectAttempts: number = 0;
  private heartbeatInterval?: NodeJS.Timeout;
  private consumerId?: string;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000; // 1 second
  private maxReconnectDelay: number = 300000; // 5 minutes
  private circuitBreakerTimeout: number = 600000; // 10 minutes
  private lastCircuitBreakerReset: number = Date.now();
  private isCircuitBreakerOpen: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('EventListener');
    this.dynamoDb = new AWS.DynamoDB.DocumentClient();
    
    try {
      this.logger.info('Starting event listener with config', {
        nftContractAddress: config.nftContractAddress,
        wsRpcUrl: config.wsRpcUrl,
        kinesisStreamName: config.kinesisStreamName
      });

      // Validate contract addresses
      if (!ethers.isAddress(config.nftContractAddress)) {
        throw new Error(`Invalid NFT contract address: ${config.nftContractAddress}`);
      }

      this.logger.info('Contract addresses validated successfully');
      this.logger.info('Attempting to connect to WebSocket provider', { 
        url: config.wsRpcUrl,
        providedNFTAddress: config.nftContractAddress
      });
      
      const wsCreator = () => {
        const ws = new WebSocket(config.wsRpcUrl, {
          handshakeTimeout: 5000,
          maxPayload: 100 * 1024 * 1024 // 100MB
        });
        
        ws.onopen = () => {
          this.logger.info('WebSocket connection established successfully');
          updateMetrics.updateWebsocket({
            connected: true,
            lastReconnectAttempt: Date.now()
          });
        };
        
        ws.onerror = (error: WebSocket.ErrorEvent) => {
          this.logger.error('WebSocket connection error in constructor', error);
          updateMetrics.updateWebsocket({
            connected: false,
            lastReconnectAttempt: Date.now(),
            reconnectAttempts: ++this.reconnectAttempts
          });
        };
        
        return ws;
      };
      
      this.provider = new WebSocketProvider(wsCreator, "base", {
        staticNetwork: true,
        batchMaxCount: 1
      });
      
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
          const events = await this.nftContract.queryFilter('*' as any, block.number, block.number);
          
          // Only log if we found relevant events
          if (events.length > 0) {
            // Count events by type
            const eventCounts = events.reduce((acc: Record<string, number>, event) => {
              let eventName = 'unknown';
              
              // Check if it's an EventLog
              if ('fragment' in event && event.fragment?.name) {
                eventName = event.fragment.name;
              } else if (event.topics?.[0]) {
                // Try to match the topic signature
                const matchedEvent = Object.entries(KNOWN_SIGNATURES)
                  .find(([_, sig]) => sig === event.topics[0]);
                if (matchedEvent) {
                  eventName = matchedEvent[0];
                }
              }
              
              acc[eventName] = (acc[eventName] || 0) + 1;
              return acc;
            }, {});

            // Only log if we found known events
            const knownEvents = Object.keys(eventCounts).filter(name => name !== 'unknown');
            if (knownEvents.length > 0) {
              this.logger.info('📥 WEBSOCKET: Received blockchain events', { 
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

    // NFT Contract Events
    this.nftContract.on('BatchMint', async (to, startTokenId, quantity, event) => {
      this.logger.info('📥 WEBSOCKET EVENT: Received BatchMint event', { 
        startTokenId: startTokenId.toString(), 
        quantity: quantity.toString(),
        to: to.toLowerCase(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
      });
      try {
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        const eventPayload: OnChainEvent = {
          type: 'BatchMint',
          to: to.toLowerCase(),
          startTokenId: startTokenId.toString(),
          quantity: quantity.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: event.index.toString(16)
        };
        
        await this.handleEvent(eventPayload);
      } catch (error) {
        this.logger.error('❌ ERROR: Failed to process BatchMint event', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            to, 
            startTokenId: startTokenId.toString(),
            quantity: quantity.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    this.nftContract.on('BatchBurn', async (from, startTokenId, quantity, event) => {
      this.logger.info('📥 WEBSOCKET EVENT: Received BatchBurn event', { 
        startTokenId: startTokenId.toString(), 
        quantity: quantity.toString(),
        from: from.toLowerCase(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
      });
      try {
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        const eventPayload: OnChainEvent = {
          type: 'BatchBurn',
          from: from.toLowerCase(),
          startTokenId: startTokenId.toString(),
          quantity: quantity.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: event.index.toString(16)
        };
        
        await this.handleEvent(eventPayload);
      } catch (error) {
        this.logger.error('❌ ERROR: Failed to process BatchBurn event', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            from,
            startTokenId: startTokenId.toString(),
            quantity: quantity.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    this.nftContract.on('BatchTransfer', async (from, to, startTokenId, quantity, event) => {
      this.logger.info('📥 WEBSOCKET EVENT: Received BatchTransfer event', { 
        startTokenId: startTokenId.toString(), 
        quantity: quantity.toString(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
      });
      try {
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        const eventPayload: OnChainEvent = {
          type: 'BatchTransfer',
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          startTokenId: startTokenId.toString(),
          quantity: quantity.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: event.index.toString(16)
        };
        
        await this.handleEvent(eventPayload);
      } catch (error) {
        this.logger.error('❌ ERROR: Failed to process BatchTransfer event', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            from,
            to,
            startTokenId: startTokenId.toString(),
            quantity: quantity.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    // Add Stake and Unstake event listeners
    this.nftContract.on('Stake', async (account, tokenId, event) => {
      const eventId = `${event.blockNumber}-${event.transactionHash}-${event.index.toString(16)}`;
      this.logger.info('📥 WEBSOCKET EVENT: Received Stake event', { 
        tokenId: tokenId.toString(),
        account: account.toLowerCase(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        eventId
      });
      try {
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        await this.handleEvent({
          type: 'Stake',
          account: account.toLowerCase(),
          tokenId: tokenId.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: event.index.toString(16)
        });
      } catch (error) {
        this.logger.error('❌ ERROR: Failed to process Stake event', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            account: account.toLowerCase(), 
            tokenId: tokenId.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    this.nftContract.on('Unstake', async (account, tokenId, event) => {
      this.logger.info('📥 WEBSOCKET EVENT: Received Unstake event', { 
        tokenId: tokenId.toString(),
        account: account.toLowerCase(),
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
      });
      try {
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        const eventPayload: OnChainEvent = {
          type: 'Unstake',
          account: account.toLowerCase(),
          tokenId: tokenId.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: event.index.toString(16)
        };
        
        await this.handleEvent(eventPayload);
      } catch (error) {
        this.logger.error('❌ ERROR: Failed to process Unstake event', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            account: account.toLowerCase(),
            tokenId: tokenId.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

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

  private async handleEvent(event: OnChainEvent) {
    try {
      // Create a unique event identifier for deduplication
      const eventId = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;
      
      this.logger.info('📤 KINESIS: Starting event processing', {
        eventType: event.type,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        ...(event.type === 'Stake' || event.type === 'Unstake' 
          ? { tokenId: (event as { type: 'Stake' | 'Unstake', tokenId: string }).tokenId }
          : { 
              startTokenId: (event as { type: 'BatchMint' | 'BatchBurn' | 'BatchTransfer', startTokenId: string }).startTokenId,
              quantity: (event as { type: 'BatchMint' | 'BatchBurn' | 'BatchTransfer', quantity: string }).quantity 
            }),
        eventId
      });

      // Check DynamoDB for duplicate event
      const checkDuplicate = await this.dynamoDb.get({
        TableName: `${this.config.kinesisStreamName}-events`,
        Key: {
          eventId: eventId
        }
      }).promise();

      if (checkDuplicate.Item) {
        this.logger.info('🔄 KINESIS: Duplicate event detected, skipping', {
          eventId,
          eventType: event.type,
          transactionHash: event.transactionHash
        });
        return;
      }

      // Update event metrics based on type
      updateMetrics.incrementEvent(event.type.toLowerCase() as 'batchTransfer' | 'batchMint' | 'batchBurn' | 'stake' | 'unstake' | 'errors');
      this.logger.info('📊 METRICS: Updated for event type', {
        eventType: event.type,
        metricsUpdated: true
      });
      
      // Verify Kinesis credentials before sending
      const credentials = await this.kinesis.config.credentials();
      this.logger.info('🔐 KINESIS: Verified credentials', {
        hasValidCredentials: !!credentials
      });
      
      const data = Buffer.from(JSON.stringify(event));
      
      // Calculate queue position based on event type
      const queueOrder = (() => {
        const blockPart = event.blockNumber.toString().padStart(9, '0');
        const txPart = event.transactionIndex.toString().padStart(6, '0');
        
        switch (event.type) {
          case 'Unstake': {
            // For unstaked tokens, use negative numbers to ensure front of queue
            const unstakeEvent = event as { type: 'Unstake', tokenId: string };
            const tokenNum = parseInt(unstakeEvent.tokenId);
            const negativePosition = (-999999 + (tokenNum % 999999)).toString().padStart(6, '0');
            return `${blockPart}${txPart}-${negativePosition}`;
          }
            
          case 'BatchTransfer':
          case 'BatchMint': {
            // For purchases/transfers, use positive numbers (back of queue)
            const batchEvent = event as { type: 'BatchMint' | 'BatchTransfer', startTokenId: string };
            const startTokenNum = parseInt(batchEvent.startTokenId);
            const last6Digits = startTokenNum.toString().padStart(6, '0');
            return `${blockPart}${txPart}${last6Digits}`;
          }
            
          case 'Stake':
            // For staked tokens, don't assign a queue position since they're removed from queue
            return '';
            
          case 'BatchBurn': {
            // For burned tokens, they'll be removed from queue in DB layer
            const burnEvent = event as { type: 'BatchBurn', startTokenId: string };
            const burnTokenNum = parseInt(burnEvent.startTokenId);
            const burnLast6Digits = burnTokenNum.toString().padStart(6, '0');
            return `${blockPart}${txPart}${burnLast6Digits}`;
          }
        }
      })();
      
      // Generate a unique partition key using available data and queue order
      const partitionKey = (() => {
        switch (event.type) {
          case 'BatchMint':
          case 'BatchBurn':
          case 'BatchTransfer':
            return `${event.type}-${event.startTokenId}-${event.transactionHash}-${queueOrder}`;
          case 'Stake':
          case 'Unstake':
            return `${event.type}-${event.tokenId}-${event.transactionHash}-${queueOrder}`;
        }
      })();

      // Only include queueOrder in enriched event if it's not empty
      const enrichedEvent = {
        ...event,
        ...(queueOrder && { queueOrder }),
        eventId
      };

      const command = new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        PartitionKey: partitionKey,
        Data: Buffer.from(JSON.stringify(enrichedEvent))
      });

      this.logger.info('📤 KINESIS: Sending event', {
        streamName: this.config.kinesisStreamName,
        eventType: event.type,
        transactionHash: event.transactionHash,
        queueOrder,
        eventId,
        dataSize: data.length
      });

      const result = await this.kinesis.send(command);

      // Store event ID in DynamoDB for deduplication
      await this.dynamoDb.put({
        TableName: `${this.config.kinesisStreamName}-events`,
        Item: {
          eventId: eventId,
          timestamp: Date.now(),
          ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour TTL
        }
      }).promise();

      // Log success with type-safe event properties
      const logData = {
        eventType: event.type,
        shardId: result.ShardId,
        sequenceNumber: result.SequenceNumber,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        timestamp: new Date().toISOString(),
        streamName: this.config.kinesisStreamName,
        partitionKey,
        queueOrder,
        eventId
      };

      // Add type-specific properties to log data
      if (event.type === 'BatchMint' || event.type === 'BatchBurn' || event.type === 'BatchTransfer') {
        const batchEvent = event as { type: 'BatchMint' | 'BatchBurn' | 'BatchTransfer', startTokenId: string, quantity: string };
        Object.assign(logData, { 
          startTokenId: batchEvent.startTokenId,
          quantity: batchEvent.quantity
        });
      } else if (event.type === 'Stake' || event.type === 'Unstake') {
        const stakeEvent = event as { type: 'Stake' | 'Unstake', tokenId: string };
        Object.assign(logData, {
          tokenId: stakeEvent.tokenId
        });
      }

      this.logger.info('✅ KINESIS: Event sent successfully', logData);

      // Update Kinesis metrics
      updateMetrics.updateKinesis({
        recordsSent: metrics.kinesis.recordsSent + 1,
        batchesSent: metrics.kinesis.batchesSent + 1,
        lastBatchTime: Date.now()
      });

    } catch (error) {
      this.logger.error('❌ KINESIS: Failed to send event', { 
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
          requestId: (error as any).$metadata?.requestId
        } : error,
        eventDetails: {
          type: event.type,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber
        }
      });
      
      // Update local metrics
      updateMetrics.incrementEvent('errors');
      updateMetrics.updateKinesis({
        errors: metrics.kinesis.errors + 1
      });

      // Publish error metric to CloudWatch
      await this.metrics.publishMetric({
        name: 'ErrorCount',
        value: 1,
        unit: 'Count',
        dimensions: {
          ErrorType: 'KinesisError',
          Environment: this.config.environment
        }
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
    if (this.isCircuitBreakerOpen) {
      if (Date.now() - this.lastCircuitBreakerReset > this.circuitBreakerTimeout) {
        this.logger.info('Circuit breaker timeout elapsed, resetting circuit breaker');
        this.isCircuitBreakerOpen = false;
        this.reconnectAttempts = 0;
        this.lastCircuitBreakerReset = Date.now();
      } else {
        this.logger.warn('Circuit breaker is open, skipping reconnection attempt');
        return;
      }
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached, opening circuit breaker');
      this.isCircuitBreakerOpen = true;
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: this.reconnectAttempts,
        circuitBreakerOpen: true
      });
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.logger.info('Attempting to reconnect', {
      attempt: this.reconnectAttempts + 1,
      delay,
      maxAttempts: this.maxReconnectAttempts
    });

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      // Stop existing listeners and intervals
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
      
      // Create new provider and contracts
      const wsCreator = this.createWebSocketProvider();
      this.provider = new WebSocketProvider(wsCreator, "base", {
        staticNetwork: true,
        batchMaxCount: 1
      });

      this.nftContract = new Contract(this.config.nftContractAddress, EVENT_ABIS, this.provider);
      
      // Reinitialize event listeners
      await this.setupEventListeners();
      this.startHeartbeat();

      this.logger.info('Reconnection successful');
      this.reconnectAttempts = 0;
      updateMetrics.updateWebsocket({
        connected: true,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: 0,
        circuitBreakerOpen: false
      });
    } catch (error) {
      this.reconnectAttempts++;
      this.logger.error('Reconnection attempt failed', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error,
        attempt: this.reconnectAttempts,
        nextDelay: Math.min(
          this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
          this.maxReconnectDelay
        )
      });
      
      updateMetrics.updateWebsocket({
        connected: false,
        lastReconnectAttempt: Date.now(),
        reconnectAttempts: this.reconnectAttempts,
        circuitBreakerOpen: false
      });

      // Schedule next reconnection attempt
      setTimeout(() => this.reconnect(), 0);
    }
  }

  private createWebSocketProvider() {
    return () => {
      const ws = new WebSocket(this.config.wsRpcUrl, {
        handshakeTimeout: 5000,
        maxPayload: 100 * 1024 * 1024 // 100MB
      });
      
      ws.onopen = () => {
        this.logger.info('WebSocket connection established successfully');
        updateMetrics.updateWebsocket({
          connected: true,
          lastReconnectAttempt: Date.now(),
          reconnectAttempts: 0,
          circuitBreakerOpen: false
        });
      };
      
      ws.onerror = (error: WebSocket.ErrorEvent) => {
        this.logger.error('WebSocket connection error', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          reconnectAttempts: this.reconnectAttempts,
          circuitBreakerOpen: this.isCircuitBreakerOpen
        });
        
        updateMetrics.updateWebsocket({
          connected: false,
          lastReconnectAttempt: Date.now(),
          reconnectAttempts: this.reconnectAttempts,
          circuitBreakerOpen: this.isCircuitBreakerOpen
        });
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
      } catch (error) {
        this.logger.error('Failed to deregister consumer on shutdown', {
          consumerId: this.consumerId,
          error: error instanceof Error ? error.message : error
        });
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
} 