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
  awsAccountId: string;
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
    if (!response.Parameter || !response.Parameter.Value) {
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
  // Validate required environment variables
  const requiredEnvVars = [
    'AWS_REGION',
    'AWS_ACCOUNT_ID',
    'NODE_ENV'
  ];

  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  if (missingEnvVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  }

  const stage = process.env.NODE_ENV || 'development';

  try {
    // Fetch SSM parameters
    const [nftContractAddress, stakingContractAddress, wsRpcUrl, kinesisStreamName] = await Promise.all([
      getSSMParameter(`/ngu-points-system-v2/${stage}/STAGING_NFT_CONTRACT_ADDRESS`),
      getSSMParameter(`/ngu-points-system-v2/${stage}/STAGING_STAKING_CONTRACT_ADDRESS`),
      getSSMParameter(`/ngu-points-system-v2/${stage}/STAGING_WS_RPC_URL`),
      getSSMParameter(`/ngu-points-system-v2/${stage}/KINESIS_STREAM_NAME`)
    ]);

    return {
      nftContractAddress,
      stakingContractAddress,
      wsRpcUrl,
      kinesisStreamName: kinesisStreamName || `ngu-points-system-v2-events-${stage}`,
      awsRegion: process.env.AWS_REGION!,
      awsAccountId: process.env.AWS_ACCOUNT_ID!,
      port: parseInt(process.env.PORT || '3000'),
      environment: stage
    };
  } catch (error) {
    logger.error('Failed to fetch SSM parameters', error);
    throw error;
  }
}; 