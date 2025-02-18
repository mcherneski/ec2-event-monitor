export type OnChainEvent = {
  type: 'BatchMint' | 'BatchBurn' | 'BatchTransfer' | 'Staked' | 'Unstaked';
  timestamp: number;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: string;
  tokenId: string;
  startTokenId: string;
  quantity: string;
} & (
  | {
      type: 'BatchTransfer';
      from: string;
      to: string;
    }
  | {
      type: 'BatchMint';
      to: string;
    }
  | {
      type: 'BatchBurn';
      from: string;
    }
  | {
      type: 'Staked';
      staker: string;
    }
  | {
      type: 'Unstaked';
      staker: string;
    }
);

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 