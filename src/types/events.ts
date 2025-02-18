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
  startTokenId: number;
  quantity: number;
}

// BatchBurn event interface
export interface BatchBurnEvent extends BaseEvent {
  type: 'BatchBurn';
  from: string;
  startTokenId: number;
  quantity: number;
}

// BatchTransfer event interface
export interface BatchTransferEvent extends BaseEvent {
  type: 'BatchTransfer';
  from: string;
  to: string;
  startTokenId: number;
  quantity: number;
}

// Stake event interface
export interface StakeEvent extends BaseEvent {
  type: 'Stake';
  account: string;
  tokenId: number;
}

// Unstake event interface
export interface UnstakeEvent extends BaseEvent {
  type: 'Unstake';
  account: string;
  tokenId: number;
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