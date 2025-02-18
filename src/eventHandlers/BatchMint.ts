import { BatchMintEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';

export const handleBatchMint = async (
  event: BatchMintEvent,
  logger: Logger
): Promise<void> => {
  try {
    const { to, startTokenId, quantity } = event;
    
    logger.info('📥 Processing BatchMint event', {
      to,
      startTokenId,
      quantity,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Process the event...
    // Note: All values are already strings in the new type
    
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
  }
}; 