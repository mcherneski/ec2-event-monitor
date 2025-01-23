export interface OnChainEvent {
  type: 'Transfer' | 'Burn' | 'Mint' | 'Staked' | 'Unstaked';
  tokenId: string;
  id: number;
  from?: string;
  to?: string;
  staker?: string;
  timestamp: number;
  transactionHash: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: string;
}

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 