import { StakeEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';
import { PutRecordCommand } from '@aws-sdk/client-kinesis';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getHandlerClients } from './index';

export const handleStake = async (
  event: StakeEvent,
  logger: Logger
): Promise<void> => {
  const { kinesis, dynamoDb, config } = getHandlerClients();

  try {
    const { account, tokenId } = event;
    
    logger.info('📥 Processing Stake event', {
      account,
      tokenId,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Generate a unique event identifier
    const eventId = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;

    // Check for duplicate event
    const checkDuplicate = await dynamoDb.send(new GetCommand({
      TableName: `${config.kinesisStreamName}-events`,
      Key: {
        eventId: eventId
      }
    }));

    if (checkDuplicate.Item) {
      logger.info('⚠️ Duplicate Stake event detected, skipping', {
        eventId,
        transactionHash: event.transactionHash
      });
      return;
    }

    // Calculate queue order for proper event sequencing
    const blockPart = event.blockNumber.toString().padStart(9, '0');
    const txPart = event.transactionIndex.toString().padStart(6, '0');
    const queueOrder = `${blockPart}${txPart}`;

    // Generate partition key
    const partitionKey = `Stake-${tokenId}-${event.transactionHash}-${queueOrder}`;

    // Enrich event with additional data
    const enrichedEvent = {
      ...event,
      queueOrder,
      eventId
    };

    logger.info('📤 Preparing to send Stake event to Kinesis', {
      eventId,
      queueOrder,
      account,
      tokenId,
      blockNumber: event.blockNumber,
      streamName: config.kinesisStreamName
    });

    // Send to Kinesis
    const command = new PutRecordCommand({
      StreamName: config.kinesisStreamName,
      PartitionKey: partitionKey,
      Data: Buffer.from(JSON.stringify(enrichedEvent))
    });

    const result = await kinesis.send(command);

    // Store event ID in DynamoDB for deduplication
    await dynamoDb.send(new PutCommand({
      TableName: `${config.kinesisStreamName}-events`,
      Item: {
        eventId: eventId,
        timestamp: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour TTL
      }
    }));

    logger.info('✅ Stake event sent successfully', {
      eventId,
      shardId: result.ShardId,
      sequenceNumber: result.SequenceNumber,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      account,
      tokenId
    });
    
  } catch (error) {
    handleError(error, 'Stake event handler', logger, {
      eventData: {
        account: event.account,
        tokenId: event.tokenId,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
    throw error;
  }
}; 