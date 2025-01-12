import { WebSocketProvider, Contract, EventLog } from 'ethers';
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
    this.provider = new WebSocketProvider(config.wsRpcUrl);
    this.nftContract = new Contract(config.nftContractAddress, EVENT_ABIS, this.provider);
    this.stakingContract = new Contract(config.stakingContractAddress, EVENT_ABIS, this.provider);
    this.kinesis = new KinesisClient({ region: config.awsRegion });
    this.metrics = new MetricsPublisher(config.awsRegion, 'NGU/BlockchainEvents');
  }

  async start() {
    this.logger.info('Starting event listener');
    await this.setupEventListeners();
    await this.monitorConnection();
  }

  private async setupEventListeners() {
    // NFT Contract Events
    this.nftContract.on('Transfer', async (from, to, tokenId, id, event) => {
      await this.handleEvent({
        type: 'Transfer',
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
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
        blockNumber: event.blockNumber
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
        blockNumber: event.blockNumber
      });
    });

    // Staking Contract Events
    this.stakingContract.on('Staked', async (staker, tokenId, id, event) => {
      await this.handleEvent({
        type: 'Stake',
        staker: staker.toLowerCase(),
        tokenId: tokenId.toString(),
        id: id.toString(),
        timestamp: (await event.getBlock()).timestamp,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber
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
        blockNumber: event.blockNumber
      });
    });
  }

  private async handleEvent(event: OnChainEvent) {
    try {
      this.logger.info('Processing event', { event });

      // Send to Kinesis
      await this.kinesis.send(new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        PartitionKey: event.tokenId,
        Data: Buffer.from(JSON.stringify(event))
      }));

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
      this.logger.error('Failed to process event', { error, event });
      throw error;
    }
  }

  private async monitorConnection() {
    this.provider.on('error', async (error) => {
      this.logger.error('WebSocket connection error', error);
      await this.reconnect();
    });

    this.provider.on('disconnect', async () => {
      this.logger.error('WebSocket disconnected');
      await this.reconnect();
    });
  }

  private async reconnect() {
    try {
      this.logger.info('Attempting to reconnect');
      await this.provider.destroy();
      this.provider = new WebSocketProvider(this.config.wsRpcUrl);
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