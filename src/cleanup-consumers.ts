import { KinesisClient, ListStreamConsumersCommand, DeregisterStreamConsumerCommand } from '@aws-sdk/client-kinesis';
import dotenv from 'dotenv';

dotenv.config();

const region = process.env.AWS_REGION || 'us-east-1';
const accountId = process.env.AWS_ACCOUNT_ID;
const stage = process.env.STAGE || 'staging';
const streamName = `ngu-points-system-v2-events-${stage}`;

if (!accountId) {
    console.error('AWS_ACCOUNT_ID environment variable is required');
    process.exit(1);
}

const streamARN = `arn:aws:kinesis:${region}:${accountId}:stream/${streamName}`;

const kinesis = new KinesisClient({ 
    region,
    maxAttempts: 3
});

async function cleanupConsumers() {
    try {
        console.log('Starting consumer cleanup...');
        console.log(`Stream ARN: ${streamARN}`);

        // List all consumers
        const listCommand = new ListStreamConsumersCommand({
            StreamARN: streamARN
        });

        const listResponse = await kinesis.send(listCommand);
        const consumers = listResponse.Consumers || [];

        console.log(`Found ${consumers.length} consumers:`);
        consumers.forEach(consumer => {
            console.log(`- ${consumer.ConsumerName} (Status: ${consumer.ConsumerStatus}, Created: ${consumer.ConsumerCreationTimestamp})`);
        });

        if (consumers.length === 0) {
            console.log('No consumers to clean up.');
            return;
        }

        // Confirm before proceeding
        console.log('\nWARNING: This will delete all consumers for the stream.');
        console.log('Press Ctrl+C to cancel or wait 5 seconds to continue...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Deregister all consumers
        console.log('\nStarting consumer deregistration...');
        
        for (const consumer of consumers) {
            try {
                const deregisterCommand = new DeregisterStreamConsumerCommand({
                    StreamARN: streamARN,
                    ConsumerName: consumer.ConsumerName
                });

                await kinesis.send(deregisterCommand);
                console.log(`✓ Successfully deregistered consumer: ${consumer.ConsumerName}`);
            } catch (error) {
                console.error(`✗ Failed to deregister consumer ${consumer.ConsumerName}:`, 
                    error instanceof Error ? error.message : error
                );
            }
        }

        console.log('\nCleanup complete!');
        console.log(`Attempted to remove ${consumers.length} consumers.`);

    } catch (error) {
        console.error('Error during cleanup:', 
            error instanceof Error ? error.message : error
        );
        process.exit(1);
    }
}

cleanupConsumers().catch(console.error); 