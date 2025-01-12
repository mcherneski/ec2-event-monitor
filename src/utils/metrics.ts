import { CloudWatch, Dimension, StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { MetricData } from '../types/events.js';

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
        Unit: metric.unit as StandardUnit,
        Dimensions: Object.entries(metric.dimensions || {}).map(([Name, Value]) => ({
          Name,
          Value: String(Value)
        })) as Dimension[]
      }]
    });
  }
} 