#!/bin/bash
set -e

echo "Starting AMI setup..."

# Update system packages
echo "Updating system packages..."
sudo dnf update -y
sudo dnf install -y wget tar gzip jq git

# Install Node.js
echo "Installing Node.js ${NODE_VERSION}..."
sudo dnf install -y nodejs

# Verify Node.js installation
node --version
npm --version

# Configure npm to use user directory for global packages
echo "Configuring npm..."
mkdir -p /home/ec2-user/.npm-global
npm config set prefix '/home/ec2-user/.npm-global'
echo 'export PATH="/home/ec2-user/.npm-global/bin:$PATH"' >> /home/ec2-user/.bashrc
source /home/ec2-user/.bashrc

# Install pnpm globally in user space
echo "Installing pnpm..."
export PATH="/home/ec2-user/.npm-global/bin:$PATH"
npm install -g pnpm
export PNPM_HOME="/home/ec2-user/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
echo 'export PNPM_HOME="/home/ec2-user/.local/share/pnpm"' >> /home/ec2-user/.bashrc
echo 'export PATH="$PNPM_HOME:$PATH"' >> /home/ec2-user/.bashrc

# Verify pnpm installation
pnpm --version

# Install AWS CLI
echo "Installing AWS CLI..."
sudo dnf install -y unzip
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
rm -rf aws awscliv2.zip

# Install CodeDeploy Agent
echo "Installing CodeDeploy Agent..."
sudo dnf install -y ruby wget
cd /home/ec2-user
wget https://aws-codedeploy-${AWS_REGION:-us-east-1}.s3.amazonaws.com/latest/install
chmod +x ./install
sudo ./install auto
sudo systemctl enable codedeploy-agent
sudo systemctl start codedeploy-agent

# Create event monitor directory and set permissions
echo "Setting up event monitor directory..."
sudo mkdir -p /home/ec2-user/event-monitor
sudo chown ec2-user:ec2-user /home/ec2-user/event-monitor

# Set up systemd service
echo "Setting up systemd service..."
sudo mv /tmp/event-monitor.service /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/event-monitor.service
sudo systemctl daemon-reload

# Create log files with proper permissions
echo "Setting up log files..."
sudo touch /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chown ec2-user:ec2-user /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chmod 644 /var/log/event-monitor.log /var/log/event-monitor.error.log

# Set up CloudWatch agent for logging
echo "Installing and configuring CloudWatch agent..."
sudo dnf install -y amazon-cloudwatch-agent

# Configure system limits for the event monitor service
echo "Configuring system limits..."
sudo bash -c 'cat > /etc/security/limits.d/event-monitor.conf << EOL
ec2-user soft nofile 65536
ec2-user hard nofile 65536
EOL'

# Clean up
echo "Cleaning up..."
sudo dnf clean all
sudo rm -rf /var/cache/dnf/*
rm -f /home/ec2-user/install

echo "AMI setup complete!" 