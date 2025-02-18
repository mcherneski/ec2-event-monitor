export type OnChainEvent = {
  type: 'BatchMint' | 'BatchBurn' | 'BatchTransfer' | 'Stake' | 'Unstake';
  timestamp: number;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: string;
  tokenId: string;
} & (
  | {
      type: 'BatchTransfer';
      from: string;
      to: string;
      startTokenId: string;
      quantity: string;
    }
  | {
      type: 'BatchMint';
      to: string;
      startTokenId: string;
      quantity: string;
    }
  | {
      type: 'BatchBurn';
      from: string;
      startTokenId: string;
      quantity: string;
    }
  | {
      type: 'Stake';
      account: string;
    }
  | {
      type: 'Unstake';
      account: string;
    }
);

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 