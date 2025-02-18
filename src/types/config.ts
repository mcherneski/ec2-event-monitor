import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { Logger } from '../utils/logger.js';

const logger = new Logger('Config');

export interface Config {
  port: number;
  wsRpcUrl: string;
  nftContractAddress: string;
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
    logger.info('Starting to fetch SSM parameters', { stage });
    
    const parameterPaths = stage === 'prod' ? [
      `/ngu-points-system-v2/prod/NFT_CONTRACT_ADDRESS`,
      `/ngu-points-system-v2/prod/WS_RPC_URL`,
      `/ngu-points-system-v2/prod/KINESIS_STREAM_NAME`
    ] : [
      `/ngu-points-system-v2/${stage}/STAGING_NFT_CONTRACT_ADDRESS`,
      `/ngu-points-system-v2/${stage}/STAGING_WS_RPC_URL`,
      `/ngu-points-system-v2/${stage}/KINESIS_STREAM_NAME`
    ];

    logger.info('Fetching parameters', { paths: parameterPaths });

    const values = await Promise.all(
      parameterPaths.map(path => getSSMParameter(path))
    );

    const config = {
      nftContractAddress: values[0],
      wsRpcUrl: values[1],
      kinesisStreamName: values[2],
      awsRegion: process.env.AWS_REGION!,
      awsAccountId: process.env.AWS_ACCOUNT_ID!,
      port: parseInt(process.env.PORT || '3000'),
      environment: stage
    };

    logger.info('Config loaded successfully', { config });
    return config;
  } catch (error) {
    logger.error('Failed to fetch SSM parameters', {
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error,
      stage,
      environment: {
        AWS_REGION: process.env.AWS_REGION,
        NODE_ENV: process.env.NODE_ENV,
        AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID
      }
    });
    throw error;
  }
}; 