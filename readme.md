# EC2 Event Monitor

A Node.js service designed to monitor blockchain events and stream them to AWS Kinesis for near real-time data processing. This service is part of the NGU Points System infrastructure.

## Overview

The EC2 Event Monitor establishes WebSocket connections to blockchain nodes to monitor specific smart contract events, processes them, and streams them to AWS Kinesis for downstream processing. This architecture enables real-time data updates with minimal RPC costs and reduced latency.

## Features

- **Real-time Event Monitoring**: Establishes WebSocket connections to monitor blockchain events
  - Transfer events
  - Staking events
  - Minting events
  - Burning events

- **Enhanced Fan-Out Kinesis Streaming**: Uses Kinesis Enhanced Fan-Out consumers for efficient event distribution
  - Automatic consumer management
  - Graceful handling of consumer lifecycle
  - Efficient cleanup of stale consumers

- **Robust Error Handling**:
  - Automatic WebSocket reconnection with exponential backoff
  - Circuit breaker pattern for connection management
  - Graceful shutdown handling

- **Monitoring and Metrics**:
  - Health check endpoint (`/health`)
  - Readiness probe endpoint (`/ready`)
  - Detailed metrics endpoint (`/metrics`)
  - CloudWatch metrics integration

## Architecture

1. **Event Source**:
   - Connects to blockchain nodes via WebSocket
   - Monitors specified smart contracts for events
   - Validates event signatures and data

2. **Event Processing**:
   - Parses and validates blockchain events
   - Enriches events with metadata (block info, timestamps)
   - Handles event deduplication

3. **Data Streaming**:
   - Streams events to Kinesis using Enhanced Fan-Out
   - Manages consumer lifecycle
   - Ensures ordered delivery of events

4. **Monitoring**:
   - Exposes HTTP endpoints for health monitoring
   - Publishes metrics to CloudWatch
   - Logs detailed operational information

## Configuration

The service is configured through environment variables and AWS SSM parameters:

### Environment Variables
- `NODE_ENV`: Environment (staging/production)
- `AWS_REGION`: AWS region for services
- `AWS_ACCOUNT_ID`: AWS account ID
- `PORT`: Service port (default: 3000)

### SSM Parameters
- `STAGING_NFT_CONTRACT_ADDRESS`: NFT contract address
- `STAGING_STAKING_CONTRACT_ADDRESS`: Staking contract address
- `STAGING_WS_RPC_URL`: WebSocket RPC URL
- `KINESIS_STREAM_NAME`: Kinesis stream name

## Deployment

The service is deployed using AWS CodeDeploy with the following lifecycle:

1. **Before Install**: Prepares the environment and cleans up existing processes
2. **After Install**: Sets up service dependencies and configurations
3. **Application Start**: Starts the service using systemd
4. **Validate Service**: Verifies service health and connectivity

## Monitoring

### Health Checks
- `GET /health`: Returns service health status
- `GET /ready`: Returns service readiness status
- `GET /metrics`: Returns detailed metrics

### Metrics
- Event counts by type
- WebSocket connection status
- Kinesis streaming statistics
- System resource usage

## Error Handling

The service implements several error handling strategies:

1. **WebSocket Connectivity**:
   - Automatic reconnection with exponential backoff
   - Circuit breaker to prevent connection flooding
   - Heartbeat monitoring

2. **Kinesis Streaming**:
   - Enhanced Fan-Out consumer management
   - Automatic consumer cleanup
   - Error reporting and retry logic

3. **System Resources**:
   - Memory usage monitoring
   - Process health checks
   - Graceful shutdown handling

## Development

### Prerequisites
- Node.js v18+
- AWS credentials with appropriate permissions
- Access to blockchain node WebSocket endpoints

### Local Setup
1. Clone the repository
2. Copy `.env.example` to `.env`
3. Configure environment variables
4. Run `npm install`
5. Start the service with `npm start`

### Testing
- Unit tests: `npm test`
- Integration tests: `npm run test:integration`
- E2E tests: `npm run test:e2e` 