export interface OnChainEvent {
  type: 'Transfer' | 'Stake' | 'Unstake' | 'Mint' | 'Burn';
  tokenId: string;
  id: string;
  from?: string;
  to?: string;
  staker?: string;
  timestamp: number;
  transactionHash: string;
  blockNumber: number;
}

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
} 