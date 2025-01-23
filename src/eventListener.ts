import { WebSocketProvider, Contract, EventLog, id, Fragment, EventFragment } from 'ethers';
import WebSocket from 'ws';
import { KinesisClient, PutRecordCommand, DescribeStreamCommand } from '@aws-sdk/client-kinesis';
import type { Config } from './types/config.js';
import type { OnChainEvent } from './types/events.js';
import { Logger } from './utils/logger.js';
import { MetricsPublisher } from './utils/metrics.js';
import { updateMetrics, metrics } from './run.js';
import * as ethers from 'ethers';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Burn(address indexed from, uint256 indexed tokenId, uint256 id)',
  'event Mint(address indexed to, uint256 indexed tokenId, uint256 id)',
  'event Staked(address indexed staker, uint256 indexed tokenId, uint256 id)',
  'event Unstaked(address indexed staker, uint256 indexed tokenId, uint256 id)'
];

// Known signatures from the contract for validation
const KNOWN_SIGNATURES = {
  Transfer: '0x9ed053bb818ff08b8353cd46f78db1f0799f31c9e4458fdb425c10eccd2efc44',
  Burn: '0x49995e5dd6158cf69ad3e9777c46755a1a826a446c6416992167462dad033b2a',
  Mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  Staked: '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90',
  Unstaked: '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e'
};
const version = '0.0.02'
console.log('EventListener.ts version ' + version + ' loaded');
export class EventListener {
  private provider: WebSocketProvider;
  private nftContract: Contract;
  private stakingContract: Contract;
  private kinesis: KinesisClient;
  private metrics: MetricsPublisher;
  private logger: Logger;
  private config: Config;
  private reconnectAttempts: number = 0;

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

      // Validate contract addresses
      if (!ethers.isAddress(config.nftContractAddress)) {
        throw new Error(`Invalid NFT contract address: ${config.nftContractAddress}`);
      }
      if (!ethers.isAddress(config.stakingContractAddress)) {
        throw new Error(`Invalid staking contract address: ${config.stakingContractAddress}`);
      }

      this.logger.info('Contract addresses validated successfully');
      this.logger.info('Attempting to connect to WebSocket provider', { 
        url: config.wsRpcUrl,
        expectedNFTAddress: '0xd79BeDA34Abf2E1336cFB6F2dE3D0D4ae4579Da7',
        expectedStakingAddress: '0xb60efDd990f7f2A98059db9480ebd1b4b7Ba115b',
        providedNFTAddress: config.nftContractAddress,
        providedStakingAddress: config.stakingContractAddress
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
      
      this.provider = new WebSocketProvider(wsCreator, "base-sepolia", {
        staticNetwork: true,
        batchMaxCount: 1
      });
      
      this.nftContract = new Contract(config.nftContractAddress, EVENT_ABIS, this.provider);
      this.stakingContract = new Contract(config.stakingContractAddress, EVENT_ABIS, this.provider);
      
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
        nftAddress: this.nftContract.target,
        stakingAddress: this.stakingContract.target
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
    this.logger.info('Setting up event listeners', {
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target
    });

    // NFT Contract Events
    this.nftContract.on('Mint', async (to, tokenId, id, event) => {
      this.logger.info('Raw blockchain event:', {
        blockNumberType: typeof event.blockNumber,
        transactionIndexType: typeof event.transactionIndex,
        logIndexType: typeof event.index
      });

      try {
        // Wait for transaction receipt to get block info
        const receipt = await event.getTransactionReceipt();
        const block = await event.getBlock();
        
        // Convert tokenId to hex string with proper padding
        const tokenIdHex = ethers.toBeHex(tokenId, 32);
        
        // Find the Mint event log by matching the signature and tokenId
        const mintEventLog = receipt.logs.find((log: { topics: string[]; index: number }) => 
          log.topics[0] === KNOWN_SIGNATURES.Mint && 
          log.topics[2] === tokenIdHex
        );

        if (!mintEventLog) {
          throw new Error('Could not find Mint event log in transaction receipt');
        }

        const logIndex = mintEventLog.index;

        this.logger.info('Transaction receipt:', {
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: logIndex,
          blockHash: receipt.blockHash,
          status: receipt.status,
          logsLength: receipt.logs.length
        });

        const eventPayload: OnChainEvent = {
          type: 'Mint',
          to: to.toLowerCase(),
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          logIndex: logIndex.toString(16)  // Convert to hex string
        };
        
        this.logger.info('Mint event payload prepared', {
          ...eventPayload,
          hasBlockNumber: typeof eventPayload.blockNumber === 'number',
          hasTransactionIndex: typeof eventPayload.transactionIndex === 'number',
          hasLogIndex: typeof logIndex === 'number',
          blockNumberValue: eventPayload.blockNumber,
          transactionIndexValue: eventPayload.transactionIndex,
          logIndexValue: logIndex
        });

        await this.handleEvent(eventPayload);
        
      } catch (error) {
        this.logger.error('Error in Mint event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            to, 
            tokenId: tokenId.toString(), 
            id: parseInt(id.toString()),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
            logIndex: event.index
          }
        });
      }
    });

    // NFT Contract Transfer Event
    this.nftContract.on('Transfer', async (from, to, tokenId, id, event) => {
      // Skip transfers to/from staking contract
      if (typeof this.stakingContract.target === 'string' &&
          (from.toLowerCase() === this.stakingContract.target.toLowerCase() ||
           to.toLowerCase() === this.stakingContract.target.toLowerCase())) {
        this.logger.info('Skipping Transfer event involving staking contract', {
          from,
          to,
          stakingContract: this.stakingContract.target,
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          transactionHash: event.transactionHash
        });
        return;
      }

      try {
        const block = await event.getBlock();
        const receipt = await event.getTransactionReceipt();
        
        // Convert tokenId to hex string with proper padding
        const tokenIdHex = ethers.toBeHex(tokenId, 32);
        
        // Find the Transfer event log by matching the signature and tokenId
        const transferEventLog = receipt.logs.find((log: { topics: string[]; index: number }) => 
          log.topics[0] === KNOWN_SIGNATURES.Transfer && 
          log.topics[3] === tokenIdHex
        );

        if (!transferEventLog) {
          throw new Error('Could not find Transfer event log in transaction receipt');
        }

        const logIndex = transferEventLog.index;

        await this.handleEvent({
          type: 'Transfer',
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          logIndex: logIndex.toString(16)  // Convert to hex string
        });
      } catch (error) {
        this.logger.error('Error in Transfer event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            from, to, tokenId: tokenId.toString(), id: id.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    // NFT Contract Burn Event
    this.nftContract.on('Burn', async (from, tokenId, id, event) => {
      try {
        const block = await event.getBlock();
        const receipt = await event.getTransactionReceipt();
        
        // Convert tokenId to hex string with proper padding
        const tokenIdHex = ethers.toBeHex(tokenId, 32);
        
        // Find the Burn event log by matching the signature and tokenId
        const burnEventLog = receipt.logs.find((log: { topics: string[]; index: number }) => 
          log.topics[0] === KNOWN_SIGNATURES.Burn && 
          log.topics[2] === tokenIdHex
        );

        if (!burnEventLog) {
          throw new Error('Could not find Burn event log in transaction receipt');
        }

        const logIndex = burnEventLog.index;

        await this.handleEvent({
          type: 'Burn',
          from: from.toLowerCase(),
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          logIndex: logIndex.toString(16)  // Convert to hex string
        });
      } catch (error) {
        this.logger.error('Error in Burn event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            from, tokenId: tokenId.toString(), id: id.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    // Staking Contract Events
    this.stakingContract.on('Staked', async (staker, tokenId, id, event) => {
      try {
        const block = await event.getBlock();
        const receipt = await event.getTransactionReceipt();
        
        // Convert tokenId to hex string with proper padding
        const tokenIdHex = ethers.toBeHex(tokenId, 32);
        
        // Find the Staked event log by matching the signature and tokenId
        const stakedEventLog = receipt.logs.find((log: { topics: string[]; index: number }) => 
          log.topics[0] === KNOWN_SIGNATURES.Staked && 
          log.topics[2] === tokenIdHex
        );

        if (!stakedEventLog) {
          throw new Error('Could not find Staked event log in transaction receipt');
        }

        const logIndex = stakedEventLog.index;

        await this.handleEvent({
          type: 'Staked',
          staker: staker.toLowerCase(),
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          logIndex: logIndex.toString(16)  // Convert to hex string
        });
      } catch (error) {
        this.logger.error('Error in Staked event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            staker, tokenId: tokenId.toString(), id: id.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    this.stakingContract.on('Unstaked', async (staker, tokenId, id, event) => {
      try {
        const block = await event.getBlock();
        const receipt = await event.getTransactionReceipt();
        
        // Convert tokenId to hex string with proper padding
        const tokenIdHex = ethers.toBeHex(tokenId, 32);
        
        // Find the Unstaked event log by matching the signature and tokenId
        const unstakedEventLog = receipt.logs.find((log: { topics: string[]; index: number }) => 
          log.topics[0] === KNOWN_SIGNATURES.Unstaked && 
          log.topics[2] === tokenIdHex
        );

        if (!unstakedEventLog) {
          throw new Error('Could not find Unstaked event log in transaction receipt');
        }

        const logIndex = unstakedEventLog.index;

        await this.handleEvent({
          type: 'Unstaked',
          staker: staker.toLowerCase(),
          tokenId: tokenId.toString(),
          id: parseInt(id.toString()),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          logIndex: logIndex.toString(16)  // Convert to hex string
        });
      } catch (error) {
        this.logger.error('Error in Unstaked event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            staker, tokenId: tokenId.toString(), id: id.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    // Add provider-level error handling
    this.provider.on('error', (error) => {
      this.logger.error('Provider error', { error });
    });

    this.logger.info('Event listeners setup complete', {
      nftContractAddress: this.nftContract.target,
      stakingContractAddress: this.stakingContract.target
    });
  }

  private async handleEvent(event: OnChainEvent) {
    try {
      this.logger.info('Starting handleEvent processing', {
        eventType: event.type,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        contractAddresses: {
          nft: this.nftContract.target,
          staking: this.stakingContract.target
        }
      });

      // Update event metrics based on type
      updateMetrics.incrementEvent(event.type.toLowerCase() as any);
      this.logger.info('Metrics updated for event type', {
        eventType: event.type,
        metricsUpdated: true
      });
      
      // Verify Kinesis credentials before sending
      const credentials = await this.kinesis.config.credentials();
      this.logger.info('Verifying Kinesis credentials before send', {
        hasCredentials: !!credentials,
        accessKeyId: credentials?.accessKeyId ? '[REDACTED]' : undefined,
        expiration: credentials?.expiration
      });
      
      // Log the event payload and Kinesis configuration before sending
      this.logger.info('Preparing to send event to Kinesis', {
        streamName: this.config.kinesisStreamName,
        eventPayload: event,
        eventDetails: {
          hasBlockNumber: 'blockNumber' in event,
          blockNumberType: typeof event.blockNumber,
          blockNumberValue: event.blockNumber,
          hasTransactionIndex: 'transactionIndex' in event,
          transactionIndexType: typeof event.transactionIndex,
          transactionIndexValue: event.transactionIndex
        },
        payloadSize: Buffer.from(JSON.stringify(event)).length,
        kinesisConfig: {
          region: this.kinesis.config.region,
          endpoint: this.kinesis.config.endpoint,
          maxAttempts: this.kinesis.config.maxAttempts,
          retryMode: this.kinesis.config.retryMode,
          hasValidCredentials: !!credentials
        }
      });

      // Send to Kinesis
      this.logger.info('Creating PutRecordCommand', {
        streamName: this.config.kinesisStreamName,
        eventType: event.type,
        transactionHash: event.transactionHash,
        eventId: event.id,
        idType: typeof event.id,
        eventData: event
      });

      const data = Buffer.from(JSON.stringify(event));
      const command = new PutRecordCommand({
        StreamName: this.config.kinesisStreamName,
        // Use a combination of event type and display ID as partition key, ensuring id is a string
        PartitionKey: `${event.type}-${event.id.toString()}`,
        Data: data
      });

      this.logger.info('Sending event to Kinesis', {
        streamName: this.config.kinesisStreamName,
        eventType: event.type,
        transactionHash: event.transactionHash,
        command: {
          input: {
            StreamName: command.input.StreamName,
            PartitionKey: command.input.PartitionKey,
            DataSize: data.length
          }
        }
      });

      const result = await this.kinesis.send(command).catch(error => {
        this.logger.error('Kinesis send command failed', {
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: (error as any).code,
            requestId: (error as any).$metadata?.requestId,
            cfId: (error as any).$metadata?.cfId,
            httpStatusCode: (error as any).$metadata?.httpStatusCode
          } : error,
          eventDetails: {
            type: event.type,
            transactionHash: event.transactionHash
          },
          command: {
            input: {
              StreamName: command.input.StreamName,
              PartitionKey: command.input.PartitionKey,
              DataSize: data.length
            }
          }
        });
        throw error;
      });

      // Update Kinesis metrics
      updateMetrics.updateKinesis({
        recordsSent: metrics.kinesis.recordsSent + 1,
        batchesSent: metrics.kinesis.batchesSent + 1,
        lastBatchTime: Date.now()
      });

      this.logger.info('Event successfully sent to Kinesis', {
        type: event.type,
        transactionHash: event.transactionHash,
        shardId: result.ShardId,
        sequenceNumber: result.SequenceNumber,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('Failed to send event to Kinesis', { 
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
          requestId: (error as any).$metadata?.requestId,
          cfId: (error as any).$metadata?.cfId,
          httpStatusCode: (error as any).$metadata?.httpStatusCode
        } : error,
        eventDetails: {
          type: event.type,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber
        },
        kinesisStream: this.config.kinesisStreamName,
        kinesisConfig: {
          region: this.kinesis.config.region,
          endpoint: this.kinesis.config.endpoint,
          maxAttempts: this.kinesis.config.maxAttempts,
          retryMode: this.kinesis.config.retryMode
        }
      });
      updateMetrics.incrementEvent('errors');
      updateMetrics.updateKinesis({
        errors: metrics.kinesis.errors + 1
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
    this.logger.info('Attempting to reconnect...');
    updateMetrics.updateWebsocket({
      connected: false,
      lastReconnectAttempt: Date.now(),
      reconnectAttempts: ++this.reconnectAttempts
    });
    
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
    updateMetrics.updateWebsocket({
      connected: false
    });
  }
} 