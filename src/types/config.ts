export interface Config {
  port: number;
  wsRpcUrl: string;
  nftContractAddress: string;
  stakingContractAddress: string;
  kinesisStreamName: string;
  awsRegion: string;
  environment: string;
}

export const getConfig = (): Config => ({
  port: parseInt(process.env.PORT || '3000'),
  wsRpcUrl: process.env.WS_RPC_URL!,
  nftContractAddress: process.env.NFT_CONTRACT_ADDRESS!,
  stakingContractAddress: process.env.STAKING_CONTRACT_ADDRESS!,
  kinesisStreamName: process.env.KINESIS_STREAM_NAME!,
  awsRegion: process.env.AWS_REGION!,
  environment: process.env.NODE_ENV || 'development'
}); 