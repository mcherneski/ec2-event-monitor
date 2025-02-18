export type OnChainEvent = {
  type: 'Transfer' | 'Mint' | 'Staked' | 'Unstaked';
  timestamp: number;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: string;
} & (
  | {
      type: 'Transfer';
      from: string;
      to: string;
      tokenId: string;
      nft: boolean;
    }
  | {
      type: 'Mint';
      to: string;
      id: string;
    }
  | {
      type: 'Staked' | 'Unstaked';
      staker: string;
      tokenId: string;
      id: string;
    }
);

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 