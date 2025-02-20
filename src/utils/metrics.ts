import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch/dist-types/CloudWatchClient';
import { PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';

export class MetricsPublisher {
  private cloudwatch: CloudWatchClient;

  constructor(cloudwatch: CloudWatchClient) {
    this.cloudwatch = cloudwatch;
  }

  async publishMetrics(metrics: Array<{
    name: string;
    value: number;
    unit: keyof typeof StandardUnit;
    dimensions?: Array<{ Name: string; Value: string; }>;
  }>) {
    await this.cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'NGU/EventMonitor',
      MetricData: metrics.map(metric => ({
        MetricName: metric.name,
        Value: metric.value,
        Unit: StandardUnit[metric.unit],
        Dimensions: metric.dimensions,
        Timestamp: new Date()
      }))
    }));
  }
} 