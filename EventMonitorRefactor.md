# Event Monitor Refactor Documentation

## Overview
This document outlines the necessary changes to the parent directory's infrastructure code to support the new event processing architecture. The goal is to decouple event ingestion from event processing, improving reliability and scalability.

Current Architecture:
```
[Blockchain] -> [Event Monitor (EC2)] -> [DynamoDB (tokens/points tables)]
```

New Architecture:
```
[Blockchain] -> [Event Monitor (EC2)] -> [Kinesis] -> [Lambda] -> [DynamoDB]
                                           |
                                           v
                                    [CloudWatch Metrics]
                                           |
                                           v
                                    [CloudWatch Alarms] -> [SNS] -> [Slack/PagerDuty]
```

Benefits:
- Decoupled ingestion from processing
- Automatic scaling of event processing
- Better error handling and retry mechanisms
- Enhanced monitoring and alerting
- Reduced load on EC2 instance
- Event replay capability (24-hour retention)

## Changes Required in Parent Directory

### 1. serverless.yml Modifications

Add the following resources to your existing `serverless.yml`:

```yaml
service: ngu-points-event-processor

provider:
  name: aws
  runtime: nodejs18.x
  stage: ${opt:stage, 'prod'}
  region: us-east-1
  memorySize: 256
  timeout: 30
  logRetentionInDays: 14
  tracing:
    lambda: true
    apiGateway: true
  
  # Enable X-Ray
  iamRoleStatements:
    - Effect: Allow
      Action:
        - xray:PutTraceSegments
        - xray:PutTelemetryRecords
      Resource: "*"

functions:
  processKinesisEvents:
    handler: src/handlers/processKinesisEvents.handler
    description: Processes blockchain events from Kinesis and updates DynamoDB
    events:
      - kinesis:
          stream: ${self:custom.kinesisStreamName}
          startingPosition: LATEST
          batchSize: 100
          maximumRetryAttempts: 3
          bisectBatchOnError: true
          enabled: true
          # Enables parallel processing of batches
          parallelizationFactor: 10
          # Ensures ordered processing within each partition
          functionResponseType: ReportBatchItemFailures
    environment:
      TOKENS_TABLE: ${self:custom.tokensTableName}
      POINTS_TABLE: ${self:custom.pointsTableName}
      NODE_ENV: ${self:provider.stage}
      LOG_LEVEL: ${self:custom.logLevel}
    # Configure Lambda concurrency
    reservedConcurrency: 50
    # Enable active tracing
    tracing: Active
    # Configure VPC access if needed
    vpc:
      securityGroupIds:
        - ${self:custom.vpcConfig.securityGroupId}
      subnetIds: ${self:custom.vpcConfig.subnetIds}

custom:
  # Stream and table names
  kinesisStreamName: ngu-points-core-v5-events-${self:provider.stage}-v5
  tokensTableName: ngu-points-core-v5-tokens-${self:provider.stage}
  pointsTableName: ngu-points-core-v5-points-${self:provider.stage}
  
  # Environment-specific settings
  logLevel: ${self:custom.envConfig.${self:provider.stage}.logLevel}
  alarmTopicArn: ${self:custom.envConfig.${self:provider.stage}.alarmTopicArn}
  
  # VPC Configuration
  vpcConfig:
    securityGroupId: ${ssm:/ngu-points-system-v2/${self:provider.stage}/VPC_SECURITY_GROUP}
    subnetIds:
      - ${ssm:/ngu-points-system-v2/${self:provider.stage}/PRIVATE_SUBNET_1}
      - ${ssm:/ngu-points-system-v2/${self:provider.stage}/PRIVATE_SUBNET_2}
  
  # Environment-specific configurations
  envConfig:
    prod:
      logLevel: info
      alarmTopicArn: arn:aws:sns:us-east-1:339712950990:ngu-points-alarms-prod
    staging:
      logLevel: debug
      alarmTopicArn: arn:aws:sns:us-east-1:339712950990:ngu-points-alarms-staging

resources:
  Resources:
    # Kinesis Stream
    EventsKinesisStream:
      Type: AWS::Kinesis::Stream
      Properties:
        Name: ${self:custom.kinesisStreamName}
        RetentionPeriodHours: 24
        StreamModeDetails:
          StreamMode: ON_DEMAND
        Tags:
          - Key: Environment
            Value: ${self:provider.stage}
          - Key: Service
            Value: ngu-points-event-processor

    # Lambda Processor Role
    EventProcessorRole:
      Type: AWS::IAM::Role
      Properties:
        RoleName: ngu-points-event-processor-${self:provider.stage}
        Description: Role for processing blockchain events from Kinesis
        AssumeRolePolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Principal:
                Service: lambda.amazonaws.com
              Action: sts:AssumeRole
        Policies:
          - PolicyName: KinesisAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - kinesis:GetRecords
                    - kinesis:GetShardIterator
                    - kinesis:DescribeStream
                    - kinesis:ListShards
                    - kinesis:SubscribeToShard
                  Resource: !GetAtt EventsKinesisStream.Arn
          - PolicyName: DynamoDBAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - dynamodb:GetItem
                    - dynamodb:PutItem
                    - dynamodb:UpdateItem
                    - dynamodb:DeleteItem
                    - dynamodb:Query
                    - dynamodb:BatchWriteItem
                  Resource: 
                    - !Sub arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${self:custom.tokensTableName}
                    - !Sub arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${self:custom.pointsTableName}
                    - !Sub arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${self:custom.tokensTableName}/index/*
                    - !Sub arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${self:custom.pointsTableName}/index/*
          - PolicyName: CloudWatchAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - logs:CreateLogGroup
                    - logs:CreateLogStream
                    - logs:PutLogEvents
                    - cloudwatch:PutMetricData
                  Resource: "*"
          - PolicyName: VPCAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - ec2:CreateNetworkInterface
                    - ec2:DescribeNetworkInterfaces
                    - ec2:DeleteNetworkInterface
                  Resource: "*"

    # EC2 Event Monitor Role
    EventMonitorRole:
      Type: AWS::IAM::Role
      Properties:
        RoleName: ngu-points-event-monitor-${self:provider.stage}
        Description: Role for EC2 instance to send events to Kinesis
        AssumeRolePolicyDocument:
          Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Principal:
                Service: ec2.amazonaws.com
              Action: sts:AssumeRole
        Policies:
          - PolicyName: KinesisAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - kinesis:PutRecord
                    - kinesis:PutRecords
                    - kinesis:DescribeStream
                  Resource: !GetAtt EventsKinesisStream.Arn
          - PolicyName: SSMAccess
            PolicyDocument:
              Version: '2012-10-17'
              Statement:
                - Effect: Allow
                  Action:
                    - ssm:GetParameter
                    - ssm:GetParameters
                    - ssm:GetParametersByPath
                  Resource: 
                    - !Sub arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/ngu-points-system-v2/${self:provider.stage}/*

    # CloudWatch Alarms
    KinesisIteratorAgeAlarm:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: ${self:custom.kinesisStreamName}-IteratorAge
        AlarmDescription: Alert when Kinesis iterator age exceeds threshold
        MetricName: GetRecords.IteratorAgeMilliseconds
        Namespace: AWS/Kinesis
        Statistic: Maximum
        Period: 300
        EvaluationPeriods: 2
        Threshold: 3600000  # 1 hour
        ComparisonOperator: GreaterThanThreshold
        Dimensions:
          - Name: StreamName
            Value: ${self:custom.kinesisStreamName}
        AlarmActions:
          - ${self:custom.alarmTopicArn}
        OKActions:
          - ${self:custom.alarmTopicArn}

    KinesisWriteProvisionedAlarm:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: ${self:custom.kinesisStreamName}-WriteProvisioned
        AlarmDescription: Alert when Kinesis write provisioned throughput is exceeded
        MetricName: WriteProvisionedThroughputExceeded
        Namespace: AWS/Kinesis
        Statistic: Sum
        Period: 300
        EvaluationPeriods: 2
        Threshold: 1
        ComparisonOperator: GreaterThanThreshold
        Dimensions:
          - Name: StreamName
            Value: ${self:custom.kinesisStreamName}
        AlarmActions:
          - ${self:custom.alarmTopicArn}
        OKActions:
          - ${self:custom.alarmTopicArn}

    LambdaErrorsAlarm:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: ${self:custom.kinesisStreamName}-LambdaErrors
        AlarmDescription: Alert when Lambda errors exceed threshold
        MetricName: Errors
        Namespace: AWS/Lambda
        Statistic: Sum
        Period: 300
        EvaluationPeriods: 2
        Threshold: 5
        ComparisonOperator: GreaterThanThreshold
        Dimensions:
          - Name: FunctionName
            Value: ${self:service}-${self:provider.stage}-processKinesisEvents
        AlarmActions:
          - ${self:custom.alarmTopicArn}
        OKActions:
          - ${self:custom.alarmTopicArn}

    LambdaDurationAlarm:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: ${self:custom.kinesisStreamName}-LambdaDuration
        AlarmDescription: Alert when Lambda duration exceeds 80% of timeout
        MetricName: Duration
        Namespace: AWS/Lambda
        Statistic: Maximum
        Period: 300
        EvaluationPeriods: 2
        Threshold: 24000  # 24 seconds (80% of 30s timeout)
        ComparisonOperator: GreaterThanThreshold
        Dimensions:
          - Name: FunctionName
            Value: ${self:service}-${self:provider.stage}-processKinesisEvents
        AlarmActions:
          - ${self:custom.alarmTopicArn}
        OKActions:
          - ${self:custom.alarmTopicArn}

  # CloudFormation Outputs
  Outputs:
    KinesisStreamArn:
      Description: ARN of the Kinesis stream
      Value: !GetAtt EventsKinesisStream.Arn
      Export:
        Name: ${self:custom.kinesisStreamName}-arn

    EventProcessorRoleArn:
      Description: ARN of the Lambda processor role
      Value: !GetAtt EventProcessorRole.Arn
      Export:
        Name: ${self:service}-${self:provider.stage}-processor-role-arn

    EventMonitorRoleArn:
      Description: ARN of the EC2 monitor role
      Value: !GetAtt EventMonitorRole.Arn
      Export:
        Name: ${self:service}-${self:provider.stage}-monitor-role-arn
```

### 2. Environment Variables and SSM Parameters

Required SSM parameters:

```bash
# VPC Configuration
aws ssm put-parameter \
  --name "/ngu-points-system-v2/${STAGE}/VPC_SECURITY_GROUP" \
  --value "sg-xxxxx" \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/ngu-points-system-v2/${STAGE}/PRIVATE_SUBNET_1" \
  --value "subnet-xxxxx" \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/ngu-points-system-v2/${STAGE}/PRIVATE_SUBNET_2" \
  --value "subnet-xxxxx" \
  --type "String" \
  --overwrite

# Kinesis Stream Name
aws ssm put-parameter \
  --name "/ngu-points-system-v2/${STAGE}/KINESIS_STREAM_NAME" \
  --value "ngu-points-core-v5-events-${STAGE}-v5" \
  --type "String" \
  --overwrite
```

### 3. Integration Points

#### Event Monitor (EC2) Integration
The EC2 event monitor needs to:
1. Read Kinesis stream name from SSM
2. Use AWS SDK to send events to Kinesis
3. Include proper event sequencing information
4. Handle backpressure and retry logic

#### Lambda Integration with DynamoDB
The Lambda function needs to:
1. Process events in order within each partition
2. Handle DynamoDB throttling
3. Implement proper error handling and retries
4. Report partial batch failures correctly

#### Monitoring Integration
CloudWatch metrics to track:
1. Event Monitor:
   - WebSocket connection status
   - Event ingestion rate
   - Kinesis write success/failure
   - Memory usage
   - CPU usage

2. Kinesis:
   - Iterator age
   - Write throughput
   - Read throughput
   - Throttling events

3. Lambda:
   - Invocation count
   - Error count
   - Duration
   - Memory usage
   - Concurrent executions

4. DynamoDB:
   - Write capacity utilization
   - Read capacity utilization
   - Throttled requests
   - Error count

### 4. Critical Component Monitoring

#### High Priority Alerts (Page on-call)
1. Event Monitor:
   - WebSocket disconnection > 5 minutes
   - Event processing errors > 5% in 5 minutes

2. Kinesis:
   - Iterator age > 1 hour
   - Write throttling > 10 events in 5 minutes

3. Lambda:
   - Error rate > 5% in 5 minutes
   - Duration > 80% of timeout
   - Throttling > 10 events in 5 minutes

4. DynamoDB:
   - Write throttling > 10 events in 5 minutes
   - Error rate > 5% in 5 minutes

#### Medium Priority Alerts (Slack notification)
1. Event Monitor:
   - High memory usage (>80%)
   - High CPU usage (>80%)

2. Kinesis:
   - Iterator age > 15 minutes
   - Increased latency

3. Lambda:
   - Memory usage > 80%
   - Duration > 50% of timeout

4. DynamoDB:
   - Increased latency
   - Approaching capacity limits

### 5. Deployment Strategy

1. Pre-deployment:
   - Verify current system state
   - Back up DynamoDB tables
   - Alert team of deployment

2. Deployment Steps:
   ```bash
   # 1. Deploy infrastructure
   cd ../
   serverless deploy --stage prod

   # 2. Verify Kinesis stream
   aws kinesis describe-stream \
     --stream-name ngu-points-core-v5-events-prod-v5

   # 3. Update EC2 instance role
   aws iam attach-role-policy \
     --role-name ngu-points-event-monitor-prod \
     --policy-arn arn:aws:iam::339712950990:policy/KinesisWriteAccess

   # 4. Deploy Lambda function
   serverless deploy function -f processKinesisEvents

   # 5. Update Event Monitor
   cd points_system/src/ec2-event-monitor
   git pull
   npm install
   npm run build
   sudo systemctl restart event-monitor
   ```

3. Post-deployment:
   - Verify metrics
   - Check logs
   - Monitor error rates
   - Validate event processing

### 6. Rollback Procedures

#### Immediate Rollback Triggers:
1. Event processing errors > 10% for 5 minutes
2. DynamoDB throttling > 20% for 5 minutes
3. Lambda errors > 10% for 5 minutes
4. Data inconsistency detected

#### Rollback Steps:
```bash
# 1. Revert EC2 event monitor
cd points_system/src/ec2-event-monitor
git checkout main
npm install
npm run build
sudo systemctl restart event-monitor

# 2. Remove new infrastructure
cd ../../../
serverless remove -f processKinesisEvents
aws kinesis delete-stream \
  --stream-name ngu-points-core-v5-events-prod-v5

# 3. Verify system state
aws dynamodb scan \
  --table-name ngu-points-core-v5-tokens-prod \
  --select COUNT

aws dynamodb scan \
  --table-name ngu-points-core-v5-points-prod \
  --select COUNT
```

### 7. Cost Analysis

Monthly estimates (based on current usage):
1. Kinesis:
   - PUT payload units: 1M events * 25KB = 25GB = $0.015
   - GET payload units: 1M events * 25KB = 25GB = $0.015
   - Total: ~$0.03/month

2. Lambda:
   - Invocations: 1M * $0.20/million = $0.20
   - Duration: 1M * 256MB * 1s avg = ~$0.30
   - Total: ~$0.50/month

3. CloudWatch:
   - Logs: ~$0.50/month
   - Metrics: ~$0.30/month
   - Alarms: ~$0.20/month
   - Total: ~$1.00/month

Total estimated cost: ~$1.53/month

### 8. Support and Maintenance

#### Troubleshooting Guide:
1. Event Monitor Issues:
   - Check WebSocket connection
   - Verify Kinesis permissions
   - Review EC2 metrics

2. Kinesis Issues:
   - Check stream metrics
   - Verify consumer health
   - Review throttling

3. Lambda Issues:
   - Check CloudWatch logs
   - Review error patterns
   - Verify permissions

4. DynamoDB Issues:
   - Check capacity metrics
   - Review error logs
   - Verify access patterns

#### Contact Information:
- Primary: Infrastructure Team
- Secondary: Platform Team
- Emergency: On-call rotation

#### Documentation:
- Architecture diagrams: `/docs/architecture`
- Runbooks: `/docs/runbooks`
- Monitoring: `/docs/monitoring`
- Recovery procedures: `/docs/recovery`
