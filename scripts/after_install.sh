#!/bin/bash
set -e  # Exit on error

cd /home/ec2-user/event-monitor

# Ensure we're running as ec2-user for the rest of the script
if [ "$(whoami)" != "ec2-user" ]; then
    exec sudo -u ec2-user /bin/bash "$0" "$@"
fi

# Source ec2-user's environment
source /home/ec2-user/.bashrc

# Install dependencies
echo "Installing dependencies..."
rm -rf node_modules dist
npm ci

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Verify dist directory exists and contains built files
if [ ! -d "dist" ] || [ ! -f "dist/run.js" ]; then
    echo "Error: Build failed - dist/run.js not found"
    exit 1
fi

# Ensure proper permissions
sudo chown -R ec2-user:ec2-user .

# Set up environment file
echo "Setting up environment file..."
rm -f .env
touch .env
sudo chown ec2-user:ec2-user .env
chmod 644 .env

# Set up basic environment variables
cat > .env << EOL
NODE_ENV=${NODE_ENV:-staging}
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=1
EOL

# Fetch environment variables from SSM
echo "Fetching environment variables from SSM..."
aws ssm get-parameters-by-path \
    --path "/ngu-points-system-v2/${NODE_ENV:-staging}" \
    --with-decryption \
    --region us-east-1 \
    --recursive \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
    param_name=$(echo "$name" | rev | cut -d'/' -f1 | rev)
    if [ "$param_name" != "NODE_ENV" ]; then
        echo "$param_name=$value" >> .env
    fi
done

# Also try to fetch any STAGING_ prefixed parameters
echo "Fetching STAGING_ prefixed parameters..."
aws ssm get-parameters-by-path \
    --path "/ngu-points-system-v2/${NODE_ENV:-staging}/STAGING_" \
    --with-decryption \
    --region us-east-1 \
    --recursive \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
    param_name=$(echo "$name" | rev | cut -d'/' -f1 | rev)
    if [ "$param_name" != "NODE_ENV" ]; then
        echo "$param_name=$value" >> .env
    fi
done

# Verify .env file
if [ ! -s .env ]; then
    echo "Error: .env file is empty or was not created"
    exit 1
fi

echo "Environment file contents (excluding sensitive data):"
grep -v "KEY\|SECRET\|PASSWORD\|PRIVATE" .env || true

# Create systemd service file
NODE_PATH=$(which node)
echo "Using Node.js from: ${NODE_PATH}"

# Create logs directory
echo "Setting up log directory..."
mkdir -p /home/ec2-user/event-monitor/logs
chown ec2-user:ec2-user /home/ec2-user/event-monitor/logs
chmod 755 /home/ec2-user/event-monitor/logs

sudo bash -c "cat > /etc/systemd/system/event-monitor.service << EOF
[Unit]
Description=NGU Event Monitor Service
After=network.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/event-monitor
Environment=NODE_ENV=staging
Environment=AWS_REGION=us-east-1
Environment=NODE_OPTIONS=\"--experimental-specifier-resolution=node\"
EnvironmentFile=/home/ec2-user/event-monitor/.env
ExecStart=${NODE_PATH} dist/run.js
Restart=always
RestartSec=10
StandardOutput=append:/home/ec2-user/event-monitor/logs/event-monitor.log
StandardError=append:/home/ec2-user/event-monitor/logs/event-monitor.error.log
SyslogIdentifier=event-monitor

[Install]
WantedBy=multi-user.target
EOF"

# Set up log files
echo "Setting up log files..."
touch /home/ec2-user/event-monitor/logs/event-monitor.log /home/ec2-user/event-monitor/logs/event-monitor.error.log
chown ec2-user:ec2-user /home/ec2-user/event-monitor/logs/event-monitor.log /home/ec2-user/event-monitor/logs/event-monitor.error.log
chmod 644 /home/ec2-user/event-monitor/logs/event-monitor.log /home/ec2-user/event-monitor/logs/event-monitor.error.log

# Stop the service if it's running
echo "Stopping existing service..."
sudo systemctl stop event-monitor || true

# Clear existing logs
echo "Clearing old logs..."
truncate -s 0 /home/ec2-user/event-monitor/logs/event-monitor.log
truncate -s 0 /home/ec2-user/event-monitor/logs/event-monitor.error.log

# Start the service
echo "Starting service..."
sudo systemctl daemon-reload
sudo systemctl enable event-monitor
sudo systemctl restart event-monitor

# Wait for service to start
echo "Waiting for service to start..."
sleep 5

# Check service status
echo "Service status:"
sudo systemctl status event-monitor

# Check logs for errors
echo "Checking logs for errors..."
echo "Standard output log:"
tail -n 50 /home/ec2-user/event-monitor/logs/event-monitor.log
echo "Error log:"
tail -n 50 /home/ec2-user/event-monitor/logs/event-monitor.error.log

# Verify service is running
if ! systemctl is-active --quiet event-monitor; then
    echo "Error: Service failed to start"
    exit 1
fi 