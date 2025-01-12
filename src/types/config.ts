import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { Logger } from '../utils/logger.js';

const logger = new Logger('Config');

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
  try {
    logger.info(`Fetching SSM parameter: ${paramName}`);
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    });
    
    const response = await client.send(command);
    if (!response.Parameter?.Value) {
      throw new Error(`Parameter ${paramName} has no value`);
    }
    logger.info(`Successfully fetched parameter: ${paramName}`);
    return response.Parameter.Value;
  } catch (error) {
    logger.error(`Failed to fetch SSM parameter: ${paramName}`, error);
    throw error;
  }
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
  logger.info(`Loading configuration for environment: ${env}`);
  
  try {
    const [wsRpcUrl, nftAddress, stakingAddress, kinesisStream] = await Promise.all([
      getSSMParameter(`/event-monitor/${env}/WS_RPC_URL`),
      getSSMParameter(`/event-monitor/${env}/NFT_CONTRACT_ADDRESS`),
      getSSMParameter(`/event-monitor/${env}/STAKING_CONTRACT_ADDRESS`),
      getSSMParameter(`/event-monitor/${env}/KINESIS_STREAM_NAME`)
    ]);
    
    const config = {
      port: parseInt(process.env.PORT || '3000'),
      wsRpcUrl,
      nftContractAddress: nftAddress,
      stakingContractAddress: stakingAddress,
      kinesisStreamName: kinesisStream,
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      environment: env
    };
    
    logger.info('Successfully loaded configuration', config);
    return config;
  } catch (error) {
    logger.error('Failed to load configuration', error);
    throw error;
  }
}; 