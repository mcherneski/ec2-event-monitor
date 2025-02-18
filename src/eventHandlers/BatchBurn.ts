import { BatchBurnEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';
import { PutRecordCommand } from '@aws-sdk/client-kinesis';
import { getHandlerClients } from './index';

export const handleBatchBurn = async (
  event: BatchBurnEvent,
  logger: Logger
): Promise<void> => {
  const { kinesis, dynamoDb, config } = getHandlerClients();

  try {
    const { from, startTokenId, quantity } = event;
    
    logger.info('📥 Processing BatchBurn event', {
      from,
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
      logger.info('⚠️ Duplicate BatchBurn event detected, skipping', {
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
    const partitionKey = `BatchBurn-${startTokenId}-${event.transactionHash}-${queueOrder}`;

    // Enrich event with additional data
    const enrichedEvent = {
      ...event,
      queueOrder,
      eventId
    };

    logger.info('📤 Preparing to send BatchBurn event to Kinesis', {
      eventId,
      queueOrder,
      from,
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

    logger.info('✅ BatchBurn event sent successfully', {
      eventId,
      shardId: result.ShardId,
      sequenceNumber: result.SequenceNumber,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      from,
      startTokenId,
      quantity
    });
    
  } catch (error) {
    handleError(error, 'BatchBurn event handler', logger, {
      eventData: {
        from: event.from,
        startTokenId: event.startTokenId,
        quantity: event.quantity,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
    throw error;
  }
}; 