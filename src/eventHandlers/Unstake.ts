import { UnstakeEvent } from '../types/events';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error';

export const handleUnstake = async (
  event: UnstakeEvent,
  logger: Logger
): Promise<void> => {
  try {
    const { account, tokenId } = event;
    
    logger.info('📥 Processing Unstake event', {
      account,
      tokenId,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });

    // Process the event...
    // Note: All numeric values (tokenId) are numbers, not strings
    
  } catch (error) {
    handleError(error, 'Unstake event handler', logger, {
      eventData: {
        account: event.account,
        tokenId: event.tokenId,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash
      }
    });
  }
}; 