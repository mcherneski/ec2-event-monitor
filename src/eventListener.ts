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
  Transfer: id('Transfer(address indexed from,address indexed to,uint256 indexed tokenId,uint256 id)'),
  Burn: id('Burn(address indexed from,uint256 indexed tokenId,uint256 id)'),
  Mint: id('Mint(address indexed to,uint256 indexed tokenId,uint256 id)'),
  Staked: id('Staked(address indexed staker,uint256 tokenId,uint256 indexed id)'),
  Unstaked: id('Unstaked(address indexed staker,uint256 tokenId,uint256 indexed id)')
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
      this.logger.info('Starting event listener with config', {
        nftContractAddress: config.nftContractAddress,
        stakingContractAddress: config.stakingContractAddress,
        wsRpcUrl: config.wsRpcUrl,
        kinesisStreamName: config.kinesisStreamName
      });

      // Log all event signatures we're watching for
      Object.entries(EVENT_SIGNATURES).forEach(([name, signature]) => {
        this.logger.info('Watching for event', {
          name,
          signature,
          abi: EVENT_ABIS.find(abi => abi.includes(name))
        });
      });

      // Log event signatures for comparison
      this.logger.info('Event signatures', {
        Transfer: id('Transfer(address indexed from,address indexed to,uint256 indexed tokenId,uint256 id)'),
        Burn: id('Burn(address indexed from,uint256 indexed tokenId,uint256 id)'),
        Mint: id('Mint(address indexed to,uint256 indexed tokenId,uint256 id)'),
        Staked: id('Staked(address indexed staker,uint256 tokenId,uint256 indexed id)'),
        Unstaked: id('Unstaked(address indexed staker,uint256 tokenId,uint256 indexed id)'),
        // Add some variations to check
        TransferIndexed: id('Transfer(address indexed,address indexed,uint256 indexed,uint256)'),
        StakedIndexed: id('Staked(address indexed,uint256,uint256 indexed)'),
        UnstakedIndexed: id('Unstaked(address indexed,uint256,uint256 indexed)')
      });

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
          const rawData = typeof event.data === 'string' ? event.data : 
                         event.data instanceof Buffer ? event.data.toString() :
                         event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString() : 'unknown format';
          
          try {
            const parsedData = JSON.parse(rawData);
            if (parsedData.method === 'eth_subscription' && parsedData.params?.result) {
              const result = parsedData.params.result;
              this.logger.info('Parsed WebSocket event', {
                contractAddress: result.address,
                topics: result.topics,
                matchingSignatures: Object.entries(EVENT_SIGNATURES).map(([name, sig]) => ({
                  name,
                  signature: sig,
                  matches: sig === result.topics[0]
                })),
                nftContract: this.nftContract.target,
                stakingContract: this.stakingContract.target,
                isNFTContract: typeof this.nftContract.target === 'string' && result.address.toLowerCase() === this.nftContract.target.toLowerCase(),
                isStakingContract: typeof this.stakingContract.target === 'string' && result.address.toLowerCase() === this.stakingContract.target.toLowerCase()
              });
            }
          } catch (error) {
            this.logger.error('Error parsing WebSocket message', { error, rawData });
          }

          // Original logging
          this.logger.info('WebSocket message received', {
            dataSize: typeof event.data === 'string' ? event.data.length : 
                      event.data instanceof Buffer ? event.data.length :
                      event.data instanceof ArrayBuffer ? event.data.byteLength : 'unknown',
            data: rawData,
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
      
      this.logger.info('Provider created', {
        network: "base-sepolia",
        wsUrl: this.config.wsRpcUrl
      });
      
      this.nftContract = new Contract(config.nftContractAddress, EVENT_ABIS, this.provider);
      this.stakingContract = new Contract(config.stakingContractAddress, EVENT_ABIS, this.provider);
      this.kinesis = new KinesisClient({ region: config.awsRegion });
      this.metrics = new MetricsPublisher(config.awsRegion, 'NGU/BlockchainEvents');
      
      this.logger.info('Contracts initialized', {
        nftAddress: this.nftContract.target,
        stakingAddress: this.stakingContract.target,
        eventSignatures: EVENT_SIGNATURES
      });
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
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target
    });

    // Add raw event logging with more details
    this.provider.on('debug', (info) => {
      if (info.action === 'receive') {
        const receivedTopic = info.topics && info.topics[0];
        const matchingEvent = Object.entries(EVENT_SIGNATURES).find(([name, sig]) => sig === receivedTopic);
        
        this.logger.info('Raw event received', {
          eventTopic: receivedTopic,
          contractAddress: info.address,
          watchedContracts: {
            nft: this.nftContract.target,
            staking: this.stakingContract.target
          },
          matchingEventName: matchingEvent ? matchingEvent[0] : 'none',
          allTopics: info.topics,
          rawData: info.data
        });

        // Log if contract address matches
        if (info.address) {
          const isNFTContract = typeof this.nftContract.target === 'string' && 
            info.address.toLowerCase() === this.nftContract.target.toLowerCase();
          const isStakingContract = typeof this.stakingContract.target === 'string' && 
            info.address.toLowerCase() === this.stakingContract.target.toLowerCase();
          this.logger.info('Contract address check', {
            receivedAddress: info.address,
            isNFTContract,
            isStakingContract,
            nftContractAddress: this.nftContract.target,
            stakingContractAddress: this.stakingContract.target
          });
        }
      }
    });

    // Add logging for contract event registration
    this.logger.info('Registering contract event handlers', {
      nftEvents: ['Transfer', 'Mint', 'Burn'],
      stakingEvents: ['Staked', 'Unstaked'],
      nftAddress: this.nftContract.target,
      stakingAddress: this.stakingContract.target
    });

    // Log when contracts are initialized
    this.logger.info('Contract instances created', {
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target,
      providerNetwork: await this.provider.getNetwork()
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
        type: 'Staked',
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
        type: 'Unstaked',
        staker: staker.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex
      });
    });

    // Add provider-level error handling
    this.provider.on('error', (error) => {
      this.logger.error('Provider error', { error });
    });

    // Add WebSocket error handling
    const ws = this.provider.websocket as WebSocket;
    if (ws) {
      ws.onerror = (error) => {
        this.logger.error('WebSocket error', { error });
      };
    }

    this.logger.info('Event listeners setup complete', {
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target
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