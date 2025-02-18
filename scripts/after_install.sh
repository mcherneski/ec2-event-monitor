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

# Set environment to prod by default
NODE_ENV=${NODE_ENV:-prod}
echo "Deployment environment: ${NODE_ENV}"

# Set up environment file
echo "Setting up environment file..."
rm -f .env
touch .env
sudo chown ec2-user:ec2-user .env
chmod 644 .env

# Set up basic environment variables with prod as default
if [ "${NODE_ENV}" = "staging" ]; then
    echo "⚠️ WARNING: Configuring for STAGING environment..."
    cat > .env << EOL
NODE_ENV=staging
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=1
AWS_ACCOUNT_ID=339712950990
EOL
else
    echo "✅ Configuring for PRODUCTION environment..."
    cat > .env << EOL
NODE_ENV=prod
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=1
AWS_ACCOUNT_ID=339712950990
EOL
fi

# Fetch environment variables from SSM
echo "Fetching environment variables from SSM for ${NODE_ENV} environment..."
aws ssm get-parameters-by-path \
    --path "/ngu-points-system-v2/${NODE_ENV}" \
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

# Only fetch STAGING_ prefixed parameters in staging environment
if [ "${NODE_ENV}" = "staging" ]; then
    echo "⚠️ Fetching STAGING-specific parameters..."
    aws ssm get-parameters-by-path \
        --path "/ngu-points-system-v2/staging/STAGING_" \
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
fi

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

# Create logs directory with environment-specific naming
echo "Setting up log directory..."
LOG_DIR="/home/ec2-user/event-monitor/logs"
mkdir -p "${LOG_DIR}"
chown ec2-user:ec2-user "${LOG_DIR}"
chmod 755 "${LOG_DIR}"

# Create systemd service file with environment-specific settings
SERVICE_NAME="event-monitor"
if [ "${NODE_ENV}" = "staging" ]; then
    SERVICE_NAME="event-monitor-staging"
fi

sudo bash -c "cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=NGU Event Monitor Service (${NODE_ENV} environment)
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/event-monitor
Environment=NODE_ENV=${NODE_ENV}
Environment=AWS_REGION=us-east-1
Environment=NODE_OPTIONS="--experimental-specifier-resolution=node"
Environment=WS_RECONNECT_DELAY=5000
Environment=WS_MAX_RECONNECT_ATTEMPTS=20
Environment=WS_CIRCUIT_BREAKER_TIMEOUT=600000
EnvironmentFile=/home/ec2-user/event-monitor/.env
ExecStart=${NODE_PATH} dist/run.js
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_DIR}/${SERVICE_NAME}.log
StandardError=append:${LOG_DIR}/${SERVICE_NAME}.error.log
SyslogIdentifier=${SERVICE_NAME}

# Give the service some time to start up
TimeoutStartSec=30
# Limit restart attempts
StartLimitBurst=5
StartLimitIntervalSec=300

[Install]
WantedBy=multi-user.target
EOF"

# Set up log files with environment-specific names
echo "Setting up log files..."
touch "${LOG_DIR}/${SERVICE_NAME}.log" "${LOG_DIR}/${SERVICE_NAME}.error.log"
chown ec2-user:ec2-user "${LOG_DIR}/${SERVICE_NAME}.log" "${LOG_DIR}/${SERVICE_NAME}.error.log"
chmod 644 "${LOG_DIR}/${SERVICE_NAME}.log" "${LOG_DIR}/${SERVICE_NAME}.error.log"

# Stop the service if it's running
echo "Stopping existing service..."
sudo systemctl stop ${SERVICE_NAME} || true

# Clear existing logs
echo "Clearing old logs..."
truncate -s 0 "${LOG_DIR}/${SERVICE_NAME}.log"
truncate -s 0 "${LOG_DIR}/${SERVICE_NAME}.error.log"

# Start the service
echo "Starting service..."
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

# Wait for service to start
echo "Waiting for service to start..."
sleep 5

# Check service status
echo "Service status for ${NODE_ENV} environment:"
sudo systemctl status ${SERVICE_NAME}

# Check logs for errors
echo "Checking logs for errors..."
echo "Standard output log:"
tail -n 50 "${LOG_DIR}/${SERVICE_NAME}.log"
echo "Error log:"
tail -n 50 "${LOG_DIR}/${SERVICE_NAME}.error.log"

# Verify service is running
if ! systemctl is-active --quiet ${SERVICE_NAME}; then
    echo "Error: Service failed to start in ${NODE_ENV} environment"
    exit 1
fi

echo "✅ Deployment completed successfully for ${NODE_ENV} environment" 