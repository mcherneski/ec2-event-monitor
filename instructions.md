# NGU Blockchain Listener Setup Instructions

## Repository Structure
Create a new repository with the following structure:
```
ngu-blockchain-listener/
├── src/
│   ├── eventListener.ts     # WebSocket event listener implementation
│   ├── run.ts              # Express server and health checks
│   ├── types/
│   │   ├── events.ts       # Event type definitions
│   │   └── config.ts       # Configuration type definitions
│   └── utils/
│       ├── metrics.ts      # CloudWatch metrics helpers
│       └── logger.ts       # Logging utilities
├── config/
│   ├── dev.env            # Development environment variables
│   └── prod.env           # Production environment variables
├── scripts/
│   └── build.sh           # Build and deployment scripts
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

## Required Dependencies
Add the following to `package.json`:
```json
{
  "name": "ngu-blockchain-listener",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/run.js",
    "dev": "ts-node src/run.ts",
    "test": "jest"
  },
  "dependencies": {
    "@aws-sdk/client-cloudwatch": "^3.723.0",
    "@aws-sdk/client-kinesis": "^3.0.0",
    "ethers": "^6.13.5",
    "express": "^4.18.2",
    "@types/express": "^4.17.21",
    "express-ws": "^5.0.7"
  },
  "devDependencies": {
    "@types/node": "^20.10.5",
    "@typescript-eslint/eslint-plugin": "^5.62.0",
    "@typescript-eslint/parser": "^5.62.0",
    "typescript": "^5.7.2",
    "ts-node": "^10.9.2",
    "jest": "^29.7.0",
    "@types/jest": "^29.5.14"
  }
}
```

## TypeScript Configuration
Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": true,
    "types": ["node", "jest"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## Core Files Implementation

### 1. Event Types (`src/types/events.ts`)
```typescript
export interface OnChainEvent {
  type: 'Transfer' | 'Stake' | 'Unstake' | 'Mint' | 'Burn';
  tokenId: string;
  from: string;
  to: string;
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
```

### 2. Configuration Types (`src/types/config.ts`)
```typescript
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
```

### 3. Metrics Helper (`src/utils/metrics.ts`)
```typescript
import { CloudWatch } from '@aws-sdk/client-cloudwatch';
import type { MetricData } from '../types/events';

export class MetricsPublisher {
  private cloudwatch: CloudWatch;
  private namespace: string;

  constructor(region: string, namespace: string) {
    this.cloudwatch = new CloudWatch({ region });
    this.namespace = namespace;
  }

  async publishMetric(metric: MetricData) {
    await this.cloudwatch.putMetricData({
      Namespace: this.namespace,
      MetricData: [{
        MetricName: metric.name,
        Value: metric.value,
        Unit: metric.unit,
        Dimensions: Object.entries(metric.dimensions || {}).map(([Name, Value]) => ({
          Name,
          Value
        }))
      }]
    });
  }
}
```

### 4. Logger (`src/utils/logger.ts`)
```typescript
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, data?: any) {
    console.log(JSON.stringify({
      level: 'INFO',
      context: this.context,
      message,
      data,
      timestamp: new Date().toISOString()
    }));
  }

  error(message: string, error?: any) {
    console.error(JSON.stringify({
      level: 'ERROR',
      context: this.context,
      message,
      error,
      timestamp: new Date().toISOString()
    }));
  }
}
```

## Environment Variables
Create `.env.example`:
```bash
# Server Configuration
PORT=3000
NODE_ENV=development

# Blockchain Configuration
WS_RPC_URL=wss://your-websocket-rpc-url
NFT_CONTRACT_ADDRESS=0x...
STAKING_CONTRACT_ADDRESS=0x...

# AWS Configuration
AWS_REGION=us-east-1
KINESIS_STREAM_NAME=your-kinesis-stream
```

## Git Configuration
Create `.gitignore`:
```
node_modules/
dist/
.env
.env.*
!.env.example
*.log
coverage/
.DS_Store
```

## Build and Deployment
Create `scripts/build.sh`:
```bash
#!/bin/bash
npm install
npm run build
```

## Testing
Add basic Jest configuration and test examples for critical components.

## Documentation
Add detailed README.md with:
- Project overview
- Setup instructions
- Configuration guide
- Deployment instructions
- Monitoring and metrics guide
- Troubleshooting section

## CI/CD Considerations
Consider adding:
- GitHub Actions workflow for automated testing
- Deployment scripts for different environments
- Version tagging automation

## Security Considerations
1. Implement rate limiting for health check endpoints
2. Add input validation for all event processing
3. Implement proper error handling and logging
4. Use environment variables for all sensitive configuration
5. Implement proper AWS IAM roles and permissions

## Monitoring Setup
1. Configure CloudWatch metrics for:
   - Event processing latency
   - Memory usage
   - Event counts by type
   - WebSocket connection status
2. Set up appropriate alarms and notifications

## Local Development
Add Docker configuration for local testing:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

## Next Steps
1. Implement the core event listener logic
2. Add comprehensive error handling
3. Set up monitoring and alerting
4. Configure CI/CD pipelines
5. Add documentation for operational procedures 