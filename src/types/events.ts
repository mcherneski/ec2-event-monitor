// Base event interface with common properties
interface BaseEvent {
  timestamp: number;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: string;
}

// BatchMint event interface
export interface BatchMintEvent extends BaseEvent {
  type: 'BatchMint';
  to: string;
  startTokenId: string;
  quantity: string;
}

// BatchBurn event interface
export interface BatchBurnEvent extends BaseEvent {
  type: 'BatchBurn';
  from: string;
  startTokenId: string;
  quantity: string;
}

// BatchTransfer event interface
export interface BatchTransferEvent extends BaseEvent {
  type: 'BatchTransfer';
  from: string;
  to: string;
  startTokenId: string;
  quantity: string;
}

// Stake event interface
export interface StakeEvent extends BaseEvent {
  type: 'Stake';
  account: string;
  tokenId: string;
}

// Unstake event interface
export interface UnstakeEvent extends BaseEvent {
  type: 'Unstake';
  account: string;
  tokenId: string;
}

// Union type for all events
export type OnChainEvent = 
  | BatchMintEvent 
  | BatchBurnEvent 
  | BatchTransferEvent 
  | StakeEvent 
  | UnstakeEvent;

export interface MetricData {
  name: string;
  value: number;
  unit: string;
  dimensions?: Record<string, string>;
}