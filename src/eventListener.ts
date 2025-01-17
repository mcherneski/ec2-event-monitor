import { WebSocketProvider, Contract, EventLog, id } from 'ethers';
import WebSocket from 'ws';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import type { Config } from './types/config.js';
import type { OnChainEvent } from './types/events.js';
import { Logger } from './utils/logger.js';
import { MetricsPublisher } from './utils/metrics.js';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Burn(address indexed from, uint256 indexed tokenId, uint256 id)',
  'event Mint(address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Staked(address indexed staker, uint256 tokenId, uint256 indexed id)',
  'event Unstaked(address indexed staker, uint256 tokenId, uint256 indexed id)'
];

// Add event signature logging
const EVENT_SIGNATURES = {
  Transfer: id('Transfer(address,address,uint256,uint256)'),
  Burn: id('Burn(address,uint256,uint256)'),
  Mint: id('Mint(address,uint256,uint256)'),
  Staked: id('Staked(address,uint256,uint256)'),
  Unstaked: id('Unstaked(address,uint256,uint256)')
};

export class EventListener {
  private provider: WebSocketProvider;
  private nftContract: Contract;
  private stakingContract: Contract;
  private kinesis: KinesisClient;
  private metrics: MetricsPublisher;
  private logger: Logger;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('EventListener');
    
    try {
      this.logger.info('Attempting to connect to WebSocket provider', { url: config.wsRpcUrl });
      
      const wsCreator = () => {
        const ws = new WebSocket(config.wsRpcUrl, {
          handshakeTimeout: 5000,
          maxPayload: 100 * 1024 * 1024 // 100MB
        });
        
        ws.onopen = () => {
          this.logger.info('WebSocket connection established successfully', {
            url: config.wsRpcUrl,
            timestamp: new Date().toISOString()
          });
        };
        
        ws.onmessage = (event) => {
          this.logger.info('WebSocket message received', {
            dataSize: typeof event.data === 'string' ? event.data.length : 
                      event.data instanceof Buffer ? event.data.length :
                      event.data instanceof ArrayBuffer ? event.data.byteLength : 'unknown',
            data: typeof event.data === 'string' ? event.data : 
                  event.data instanceof Buffer ? event.data.toString() :
                  event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString() : 'unknown format',
            timestamp: new Date().toISOString()
          });
        };
        
        ws.onerror = (error: WebSocket.ErrorEvent) => {
          this.logger.error('WebSocket connection error in constructor', {
            error,
            timestamp: new Date().toISOString(),
            wsUrl: config.wsRpcUrl
          });
        };
        
        return ws;
      };
      
      this.provider = new WebSocketProvider(wsCreator, "base-sepolia", {
        staticNetwork: true,
        batchMaxCount: 1
      });
      
      this.nftContract = new Contract(config.nftContractAddress, EVENT_ABIS, this.provider);
      this.stakingContract = new Contract(config.stakingContractAddress, EVENT_ABIS, this.provider);
      this.kinesis = new KinesisClient({ region: config.awsRegion });
      this.metrics = new MetricsPublisher(config.awsRegion, 'NGU/BlockchainEvents');
    } catch (error) {
      this.logger.error('Failed to initialize WebSocket provider', { error });
      throw error;
    }
  }

  async start() {
    this.logger.info('Starting event listener');
    await this.setupEventListeners();
    await this.monitorConnection();
  }

  private async setupEventListeners() {
    this.logger.info('Setting up event listeners', {
      nftContract: this.config.nftContractAddress,
      stakingContract: this.config.stakingContractAddress,
      eventSignatures: EVENT_SIGNATURES,
      wsUrl: this.config.wsRpcUrl
    });

    // Log when contracts are initialized
    this.logger.info('Contract instances created', {
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target,
      providerNetwork: await this.provider.getNetwork()
    });

    // Add raw event logging
    this.provider.on('debug', (info) => {
      if (info.action === 'receive') {
        this.logger.info('Raw event received', {
          eventInfo: info,
          matchingSignature: Object.entries(EVENT_SIGNATURES).find(([name, sig]) => 
            info.topics && info.topics[0] === sig
          )?.[0] || 'none'
        });
      }
    });

    // NFT Contract Events
    this.nftContract.on('Transfer', async (from, to, tokenId, id, event) => {
      this.logger.info('Transfer event detected', {
        eventName: 'Transfer',
        contractAddress: event.address,
        eventTopics: event.topics,
        from, to, tokenId: tokenId.toString(), id: id.toString()
      });
      await this.handleEvent({
        type: 'Transfer',
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    this.nftContract.on('Mint', async (to, tokenId, id, event) => {
      await this.handleEvent({
        type: 'Mint',
        to: to.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    this.nftContract.on('Burn', async (from, tokenId, id, event) => {
      await this.handleEvent({
        type: 'Burn',
        from: from.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    // Staking Contract Events
    this.stakingContract.on('Staked', async (staker, tokenId, id, event) => {
      this.logger.info('Staked event detected', {
        eventName: 'Staked',
        contractAddress: event.address,
        eventTopics: event.topics,
        staker, tokenId: tokenId.toString(), id: id.toString()
      });
      await this.handleEvent({
        type: 'Stake',
        staker: staker.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    this.stakingContract.on('Unstaked', async (staker, tokenId, id, event) => {
      await this.handleEvent({
        type: 'Unstake',
        staker: staker.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    // Add error handlers for both contracts
    this.nftContract.on('error', (error) => {
      this.logger.error('NFT contract event error', { error, contract: this.nftContract.target });
    });

    this.stakingContract.on('error', (error) => {
      this.logger.error('Staking contract event error', { error, contract: this.stakingContract.target });
    });

    this.logger.info('Event listeners setup complete', {
      nftContractFilters: await this.nftContract.queryFilter('Transfer', -1),
      stakingContractFilters: await this.stakingContract.queryFilter('Staked', -1)
    });
  }

  private async handleEvent(event: OnChainEvent) {
    try {
      this.logger.info('Processing blockchain event', {
        type: event.type,
        tokenId: event.tokenId,
        eventData: JSON.stringify(event),
        timestamp: new Date().toISOString()
      });

      // Log Kinesis configuration
      this.logger.info('Preparing Kinesis record', {
        streamName: this.config.kinesisStreamName,
        region: this.kinesis.config.region(),
        eventType: event.type
      });

      const record = {
        StreamName: this.config.kinesisStreamName,
        PartitionKey: event.tokenId,
        Data: Buffer.from(JSON.stringify(event))
      };

      this.logger.info('Sending record to Kinesis', {
        streamName: record.StreamName,
        partitionKey: record.PartitionKey,
        dataSize: record.Data.length,
        data: record.Data.toString(),
        timestamp: new Date().toISOString()
      });

      // Send to Kinesis
      const result = await this.kinesis.send(new PutRecordCommand(record));
      
      this.logger.info('Successfully sent to Kinesis', { 
        sequenceNumber: result.SequenceNumber,
        shardId: result.ShardId,
        timestamp: new Date().toISOString(),
        eventType: event.type,
        streamName: this.config.kinesisStreamName
      });

      // Publish metrics
      await this.metrics.publishMetric({
        name: 'EventsProcessed',
        value: 1,
        unit: 'Count',
        dimensions: {
          EventType: event.type,
          Environment: this.config.environment
        }
      });
    } catch (error) {
      this.logger.error('Failed to process event', { 
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
          timestamp: new Date().toISOString()
        } : error,
        event: JSON.stringify(event),
        kinesisStream: this.config.kinesisStreamName,
        region: this.kinesis.config.region()
      });
      throw error;
    }
  }

  private async monitorConnection() {
    const ws = this.provider.websocket as WebSocket;
    
    ws.onmessage = (event) => {
      this.logger.info('WebSocket message received', {
        dataSize: typeof event.data === 'string' ? event.data.length : 
                  event.data instanceof Buffer ? event.data.length :
                  event.data instanceof ArrayBuffer ? event.data.byteLength : 'unknown',
        data: typeof event.data === 'string' ? event.data : 
              event.data instanceof Buffer ? event.data.toString() :
              event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString() : 'unknown format',
        timestamp: new Date().toISOString()
      });
    };
    
    ws.onerror = async (error: WebSocket.ErrorEvent) => {
      this.logger.error('WebSocket connection error', {
        error,
        timestamp: new Date().toISOString(),
        wsUrl: this.config.wsRpcUrl
      });
      await this.reconnect();
    };

    ws.onclose = async () => {
      this.logger.error('WebSocket disconnected', {
        timestamp: new Date().toISOString(),
        wsUrl: this.config.wsRpcUrl
      });
      await this.reconnect();
    };

    this.logger.info('Connection monitoring started', {
      wsUrl: this.config.wsRpcUrl,
      timestamp: new Date().toISOString()
    });
  }

  private async reconnect() {
    try {
      this.logger.info('Attempting to reconnect');
      await this.provider.destroy();
      
      const wsCreator = () => {
        const ws = new WebSocket(this.config.wsRpcUrl, {
          handshakeTimeout: 5000,
          maxPayload: 100 * 1024 * 1024 // 100MB
        });
        return ws;
      };
      
      this.provider = new WebSocketProvider(wsCreator, "base-sepolia", {
        staticNetwork: true,
        batchMaxCount: 1
      });
      
      await this.setupEventListeners();
      this.logger.info('Successfully reconnected');
    } catch (error) {
      this.logger.error('Failed to reconnect', error);
      // Implement exponential backoff retry logic here
      setTimeout(() => this.reconnect(), 5000);
    }
  }

  async stop() {
    this.logger.info('Stopping event listener');
    await this.provider.destroy();
  }
} 