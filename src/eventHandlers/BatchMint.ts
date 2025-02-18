import { BatchMintEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';
import { PutRecordCommand } from '@aws-sdk/client-kinesis';
import { getHandlerClients } from './index';

export const handleBatchMint = async (
  event: BatchMintEvent,
  logger: Logger
): Promise<void> => {
  const { kinesis, dynamoDb, config } = getHandlerClients();

  try {
    const { to, startTokenId, quantity } = event;
    
    logger.info('📥 Processing BatchMint event', {
      to,
      startTokenId,
      quantity,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Generate a unique event identifier
    const eventId = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;

    // Check for duplicate event
    const checkDuplicate = await dynamoDb.get({
      TableName: `${config.kinesisStreamName}-events`,
      Key: {
        eventId: eventId
      }
    }).promise();

    if (checkDuplicate.Item) {
      logger.info('⚠️ Duplicate BatchMint event detected, skipping', {
        eventId,
        transactionHash: event.transactionHash
      });
      return;
    }

    // Calculate queue order for proper event sequencing
    const blockPart = event.blockNumber.toString().padStart(9, '0');
    const txPart = event.transactionIndex.toString().padStart(6, '0');
    const last6Digits = startTokenId.toString().padStart(6, '0');
    const queueOrder = `${blockPart}${txPart}${last6Digits}`;

    // Generate partition key
    const partitionKey = `BatchMint-${startTokenId}-${event.transactionHash}-${queueOrder}`;

    // Enrich event with additional data
    const enrichedEvent = {
      ...event,
      queueOrder,
      eventId
    };

    logger.info('📤 Preparing to send BatchMint event to Kinesis', {
      eventId,
      queueOrder,
      to,
      startTokenId,
      quantity,
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
    await dynamoDb.put({
      TableName: `${config.kinesisStreamName}-events`,
      Item: {
        eventId: eventId,
        timestamp: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hour TTL
      }
    }).promise();

    logger.info('✅ BatchMint event sent successfully', {
      eventId,
      shardId: result.ShardId,
      sequenceNumber: result.SequenceNumber,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      to,
      startTokenId,
      quantity
    });
    
  } catch (error) {
    handleError(error, 'BatchMint event handler', logger, {
      eventData: {
        to: event.to,
        startTokenId: event.startTokenId,
        quantity: event.quantity,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
    throw error;
  }
}; 