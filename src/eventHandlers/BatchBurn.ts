import { BatchBurnEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';

export const handleBatchBurn = async (
  event: BatchBurnEvent,
  logger: Logger
): Promise<void> => {
  try {
    const { from, startTokenId, quantity } = event;
    
    logger.info('📥 Processing BatchBurn event', {
      from,
      startTokenId,
      quantity,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Process the event...
    // Note: All values are already strings in the new type
    
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
  }
}; 