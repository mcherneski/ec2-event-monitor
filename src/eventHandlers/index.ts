import { KinesisClient } from '@aws-sdk/client-kinesis';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Config } from '../types/config';

// Shared state for all handlers
let kinesis: KinesisClient;
let dynamoDb: DynamoDBDocument;
let config: Config;

// Initialize shared handlers
export const initializeHandlers = (
  kinesisClient: KinesisClient, 
  dynamoDbClient: DynamoDBClient, 
  appConfig: Config
) => {
  kinesis = kinesisClient;
  dynamoDb = DynamoDBDocument.from(dynamoDbClient);
  config = appConfig;
};

// Export shared state for handlers
export const getHandlerClients = () => {
  if (!kinesis || !dynamoDb || !config) {
    throw new Error('Handlers not initialized. Call initializeHandlers first.');
  }
  return { kinesis, dynamoDb, config };
};

export { handleBatchMint } from './BatchMint';
export { handleBatchBurn } from './BatchBurn';
export { handleBatchTransfer } from './BatchTransfer';
export { handleStake } from './Stake';
export { handleUnstake } from './Unstake'; 