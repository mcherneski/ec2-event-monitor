import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

export interface Config {
  port: number;
  wsRpcUrl: string;
  nftContractAddress: string;
  stakingContractAddress: string;
  kinesisStreamName: string;
  awsRegion: string;
  environment: string;
}

async function getSSMParameter(paramName: string): Promise<string> {
  const client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const command = new GetParameterCommand({
    Name: paramName,
    WithDecryption: true,
  });
  
  const response = await client.send(command);
  return response.Parameter?.Value || '';
}

export const getConfig = async (): Promise<Config> => {
  // If we're in development, use environment variables
  if (process.env.NODE_ENV === 'development') {
    return {
      port: parseInt(process.env.PORT || '3000'),
      wsRpcUrl: process.env.WS_RPC_URL!,
      nftContractAddress: process.env.NFT_CONTRACT_ADDRESS!,
      stakingContractAddress: process.env.STAKING_CONTRACT_ADDRESS!,
      kinesisStreamName: process.env.KINESIS_STREAM_NAME!,
      awsRegion: process.env.AWS_REGION!,
      environment: process.env.NODE_ENV || 'development'
    };
  }
  
  // In production, fetch from SSM
  const env = process.env.NODE_ENV || 'dev';
  const [wsRpcUrl, nftAddress, stakingAddress, kinesisStream] = await Promise.all([
    getSSMParameter(`/event-monitor/${env}/WS_RPC_URL`),
    getSSMParameter(`/event-monitor/${env}/NFT_CONTRACT_ADDRESS`),
    getSSMParameter(`/event-monitor/${env}/STAKING_CONTRACT_ADDRESS`),
    getSSMParameter(`/event-monitor/${env}/KINESIS_STREAM_NAME`)
  ]);
  
  return {
    port: parseInt(process.env.PORT || '3000'),
    wsRpcUrl,
    nftContractAddress: nftAddress,
    stakingContractAddress: stakingAddress,
    kinesisStreamName: kinesisStream,
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    environment: env
  };
}; 