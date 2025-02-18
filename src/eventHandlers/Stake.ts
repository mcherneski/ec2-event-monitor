import { StakeEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';

export const handleStake = async (
  event: StakeEvent,
  logger: Logger
): Promise<void> => {
  try {
    const { account, tokenId } = event;
    
    logger.info('📥 Processing Stake event', {
      account,
      tokenId,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Process the event...
    // Note: All values are already strings in the new type
    
  } catch (error) {
    handleError(error, 'Stake event handler', logger, {
      eventData: {
        account: event.account,
        tokenId: event.tokenId,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
  }
}; 