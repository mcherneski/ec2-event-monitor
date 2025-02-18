import { BatchTransferEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';

export const handleBatchTransfer = async (
  event: BatchTransferEvent,
  logger: Logger
): Promise<void> => {
  try {
    const { from, to, startTokenId, quantity } = event;
    
    logger.info('📥 Processing BatchTransfer event', {
      from,
      to,
      startTokenId,
      quantity,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Process the event...
    // Note: All numeric values (startTokenId, quantity) are numbers, not strings
    
  } catch (error) {
    handleError(error, 'BatchTransfer event handler', logger, {
      eventData: {
        from: event.from,
        to: event.to,
        startTokenId: event.startTokenId,
        quantity: event.quantity,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
  }
}; 