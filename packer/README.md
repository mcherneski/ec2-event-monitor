# NGU Event Monitor AMI Builder

This directory contains Packer configuration to build a custom AMI for the NGU Event Monitor service.

## Prerequisites

1. Install Packer (https://www.packer.io/downloads)
2. Configure AWS credentials
3. Install the Amazon plugin for Packer:
   ```bash
   packer init .
   ```

## What's Included

The AMI comes pre-configured with:

- Node.js 18.x
- pnpm package manager
- AWS CLI v2
- CodeDeploy Agent
- CloudWatch Agent
- Systemd service configuration
- Log file setup
- System limits configuration

## Building the AMI

1. Initialize Packer plugins:
   ```bash
   packer init .
   ```

2. Validate the configuration:
   ```bash
   packer validate .
   ```

3. Build the AMI:
   ```bash
   packer build -var="stage=staging" .
   ```

   For production:
   ```bash
   packer build -var="stage=prod" .
   ```

## Variables

You can customize the build using these variables:

- `aws_region`: AWS region (default: us-east-1)
- `instance_type`: Instance type for building (default: t3.micro)
- `ami_name_prefix`: Prefix for AMI name (default: ngu-event-monitor)
- `stage`: Environment stage (default: staging)

Example with custom variables:
```bash
packer build \
  -var="aws_region=us-west-2" \
  -var="instance_type=t3.small" \
  -var="stage=staging" \
  .
```

## AMI Updates

The AMI should be rebuilt:
1. When Node.js version needs updating
2. After major system package updates
3. When new base dependencies are required
4. Monthly for security updates

## Using the AMI

After building, update the Launch Template in `serverless.yml` with the new AMI ID:

```yaml
LaunchTemplateData:
  ImageId: ${env:AMI_ID, 'ami-xxxxx'} # Replace with new AMI ID
``` 