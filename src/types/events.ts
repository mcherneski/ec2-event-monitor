export interface OnChainEvent {
  type: 'Transfer' | 'Staked' | 'Unstaked' | 'Mint' | 'Burn';
  tokenId: string;
  id: string;
  from?: string;
  to?: string;
  staker?: string;
  timestamp: number;
  transactionHash: string;
  blockNumber: number;
  transactionIndex: number;
}

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 