import { WebSocketProvider, Contract, EventLog, id, Fragment, EventFragment } from 'ethers';
import WebSocket from 'ws';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import type { Config } from './types/config.js';
import type { OnChainEvent } from './types/events.js';
import { Logger } from './utils/logger.js';
import { MetricsPublisher } from './utils/metrics.js';

// ABI fragments for the events we care about
const EVENT_ABIS = [
  'event Transfer(address,address,uint256,uint256)',
  'event Burn(address,uint256,uint256)',
  'event Mint(address,uint256,uint256)',
  'event Staked(address,uint256,uint256)',
  'event Unstaked(address,uint256,uint256)'
];

// Known signatures from the contract for validation
const KNOWN_SIGNATURES = {
  Transfer: '0x9ed053bb818ff08b8353cd46f78db1f0799f31c9e4458fdb425c10eccd2efc44',
  Burn: '0x49995e5dd6158cf69ad3e9777c46755a1a826a446c6416992167462dad033b2a',
  Mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  Staked: '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90',
  Unstaked: '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e'
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
              const eventSignature = result.topics[0];
              
              // Find which event this signature corresponds to
              const eventType = Object.entries(KNOWN_SIGNATURES).find(
                ([_, sig]) => sig === eventSignature
              )?.[0];

              this.logger.info('Processing blockchain event', {
                contractAddress: result.address,
                topics: result.topics,
                data: result.data,
                blockNumber: result.blockNumber,
                transactionHash: result.transactionHash,
                eventType,
                matchedSignature: eventSignature,
                nftContractAddress: this.nftContract.target,
                addressMatch: typeof this.nftContract.target === 'string' ? 
                  result.address.toLowerCase() === this.nftContract.target.toLowerCase() : false
              });

              // Let ethers parse the event
              if (typeof this.nftContract.target === 'string' && 
                  result.address.toLowerCase() === this.nftContract.target.toLowerCase()) {
                try {
                  const parsedLog = this.nftContract.interface.parseLog({
                    topics: result.topics,
                    data: result.data
                  });
                  if (parsedLog) {
                    this.logger.info('Event parsed successfully', {
                      name: parsedLog.name,
                      args: parsedLog.args,
                      signature: parsedLog.signature,
                      contractAddress: result.address,
                      allTopics: result.topics,
                      rawData: result.data,
                      matchedSignature: KNOWN_SIGNATURES[parsedLog.name as keyof typeof KNOWN_SIGNATURES],
                      eventFragment: parsedLog.fragment.format()
                    });

                    // Emit the event manually to trigger the handler
                    const args = [...parsedLog.args, {
                      ...result,
                      getBlock: () => this.provider.getBlock(result.blockHash)
                    }];
                    
                    this.logger.info('Attempting to emit event', {
                      eventName: parsedLog.name,
                      args: args.map(arg => arg?.toString())
                    });
                    
                    this.nftContract.emit(parsedLog.name, ...args);
                  }
                } catch (error) {
                  this.logger.error('Failed to parse NFT contract event', {
                    error,
                    topics: result.topics,
                    data: result.data,
                    contractAddress: result.address,
                    nftContractAddress: this.nftContract.target
                  });
                }
              }
            }
          } catch (error) {
            this.logger.error('Error parsing WebSocket message', { error, rawData });
          }
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

    // NFT Contract Events
    this.nftContract.on('Mint', async (to, tokenId, id, event) => {
      this.logger.info('Mint event detected', {
        eventName: 'Mint',
        contractAddress: event.address,
        eventTopics: event.topics,
        to,
        tokenId: tokenId.toString(),
        id: id.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      });

      try {
        const block = await event.getBlock();
        this.logger.info('Retrieved block information for Mint', {
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          eventType: 'Mint'
        });

        await this.handleEvent({
          type: 'Mint',
          to: to.toLowerCase(),
          tokenId: tokenId.toString(),
          id: id.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex
        });
      } catch (error) {
        this.logger.error('Error in Mint event handler', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack
          } : error,
          eventData: {
            to, tokenId: tokenId.toString(), id: id.toString(),
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash
          }
        });
      }
    });

    // Add raw event logging with more details
    this.provider.on('debug', (info) => {
      if (info.action === 'receive') {
        const receivedTopic = info.topics && info.topics[0];
        
        // Let ethers parse the event
        if (info.address && typeof this.nftContract.target === 'string' && 
            info.address.toLowerCase() === this.nftContract.target.toLowerCase()) {
          try {
            const parsedLog = this.nftContract.interface.parseLog({
              topics: info.topics || [],
              data: info.data || '0x'
            });
            if (parsedLog) {
              this.logger.info('Raw event parsed', {
                name: parsedLog.name,
                args: parsedLog.args,
                signature: parsedLog.signature,
                contractAddress: info.address,
                allTopics: info.topics,
                rawData: info.data,
                matchedSignature: KNOWN_SIGNATURES[parsedLog.name as keyof typeof KNOWN_SIGNATURES]
              });
            }
          } catch (error) {
            this.logger.error('Failed to parse event', {
              error,
              topics: info.topics,
              data: info.data,
              contractAddress: info.address,
              nftContractAddress: this.nftContract.target
            });
          }
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
      // Skip transfers to/from staking contract
      if (typeof this.stakingContract.target === 'string' &&
          (from.toLowerCase() === this.stakingContract.target.toLowerCase() ||
           to.toLowerCase() === this.stakingContract.target.toLowerCase())) {
        this.logger.info('Skipping Transfer event involving staking contract', {
          from,
          to,
          stakingContract: this.stakingContract.target,
          tokenId: tokenId.toString(),
          id: id.toString(),
          transactionHash: event.transactionHash
        });
        return;
      }

      this.logger.info('Transfer event detected', {
        eventName: 'Transfer',
        contractAddress: event.address,
        eventTopics: event.topics,
        from, to, 
        tokenId: tokenId.toString(), 
        id: id.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      });

      try {
        const block = await event.getBlock();
        this.logger.info('Retrieved block information', {
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          eventType: 'Transfer'
        });

        await this.handleEvent({
          type: 'Transfer',
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          tokenId: tokenId.toString(),
          id: id.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex
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
        staker, 
        tokenId: tokenId.toString(), 
        id: id.toString(),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      });

      try {
        const block = await event.getBlock();
        this.logger.info('Retrieved block information', {
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          eventType: 'Staked'
        });

        await this.handleEvent({
          type: 'Staked',
          staker: staker.toLowerCase(),
          tokenId: tokenId.toString(),
          id: id.toString(),
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex
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

    // Add provider-level debug logging
    this.provider.on('debug', (info) => {
      if (info.action === 'receive') {
        this.logger.info('Raw event received', {
          action: info.action,
          contractAddress: info.address,
          topics: info.topics,
          data: info.data
        });
      }
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
      this.logger.info('ENTERING handleEvent', {
        type: event.type,
        tokenId: event.tokenId,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: new Date().toISOString()
      });

      // Validate Kinesis client
      if (!this.kinesis) {
        throw new Error('Kinesis client is not initialized');
      }

      // Log Kinesis configuration
      this.logger.info('Kinesis configuration check', {
        streamName: this.config.kinesisStreamName,
        region: this.kinesis.config.region(),
        credentials: await this.kinesis.config.credentials(),
        eventType: event.type
      });

      const record = {
        StreamName: this.config.kinesisStreamName,
        PartitionKey: event.tokenId,
        Data: Buffer.from(JSON.stringify(event))
      };

      this.logger.info('Attempting to send record to Kinesis', {
        streamName: record.StreamName,
        partitionKey: record.PartitionKey,
        dataSize: record.Data.length,
        data: record.Data.toString(),
        timestamp: new Date().toISOString()
      });

      // Send to Kinesis with detailed error handling
      try {
        const result = await this.kinesis.send(new PutRecordCommand(record));
        this.logger.info('Successfully sent to Kinesis', { 
          sequenceNumber: result.SequenceNumber,
          shardId: result.ShardId,
          timestamp: new Date().toISOString(),
          eventType: event.type,
          streamName: this.config.kinesisStreamName
        });
      } catch (kinesisError) {
        this.logger.error('Kinesis PutRecord failed', {
          error: kinesisError instanceof Error ? {
            message: kinesisError.message,
            name: kinesisError.name,
            stack: kinesisError.stack
          } : kinesisError,
          record: {
            streamName: record.StreamName,
            partitionKey: record.PartitionKey,
            dataSize: record.Data.length
          }
        });
        throw kinesisError;
      }

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
      const rawData = typeof event.data === 'string' ? event.data : 
                      event.data instanceof Buffer ? event.data.toString() :
                      event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString() : 'unknown format';
      
      this.logger.info('WebSocket message received', {
        dataSize: typeof event.data === 'string' ? event.data.length : 
                  event.data instanceof Buffer ? event.data.length :
                  event.data instanceof ArrayBuffer ? event.data.byteLength : 'unknown',
        data: rawData,
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