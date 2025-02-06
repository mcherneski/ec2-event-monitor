#!/bin/bash
set -e  # Exit on error

cd /home/ec2-user/event-monitor

# Ensure we're running as ec2-user for the rest of the script
if [ "$(whoami)" != "ec2-user" ]; then
    exec sudo -u ec2-user /bin/bash "$0" "$@"
fi

# Source ec2-user's environment
source /home/ec2-user/.bashrc

# Verify pnpm is in path
echo "Verifying pnpm installation..."
export PATH="/home/ec2-user/.local/share/pnpm:$PATH"
if ! command -v pnpm &> /dev/null; then
    echo "pnpm not found in PATH. Installing..."
    npm install -g pnpm
    export PNPM_HOME="/home/ec2-user/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
fi

# Install production dependencies
echo "Installing dependencies..."
rm -rf node_modules
rm -f pnpm-lock.yaml  # Remove existing lock file

# Ensure proper permissions
sudo chown -R ec2-user:ec2-user .

# Install dependencies as ec2-user
echo "Running pnpm install..."
pnpm install --prod --no-frozen-lockfile

echo "Installed packages:"
ls -la node_modules/.pnpm/
echo "Checking for ws package:"
ls -la node_modules/ws || echo "ws package not found!"

# Ensure dist directory exists with correct permissions
mkdir -p dist
sudo chown -R ec2-user:ec2-user .

# Set up environment file
echo "Setting up environment file..."
# Remove old .env file if it exists
rm -f .env
touch .env
sudo chown ec2-user:ec2-user .env
chmod 644 .env

echo "Fetching environment variables from SSM..."
# First set required environment variables
cat > .env << EOL
NODE_ENV=staging
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=1
EOL

# Then fetch all other environment variables from SSM Parameter Store
aws ssm get-parameters-by-path \
    --path "/ngu-points-system-v2/staging" \
    --with-decryption \
    --region us-east-1 \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
    # Extract parameter name after the last '/'
    param_name=$(echo "$name" | rev | cut -d'/' -f1 | rev)
    if [ "$param_name" != "NODE_ENV" ]; then
        echo "$param_name=$value" >> .env
    fi
done

# Verify .env file was created and has content
if [ ! -s .env ]; then
    echo "Error: .env file is empty or was not created"
    exit 1
else
    echo "Environment variables loaded from SSM (excluding sensitive values):"
    grep -v "KEY\|SECRET\|PASSWORD" .env || true
fi

echo "After install completed successfully"

# Create systemd service file
echo "Creating systemd service file..."
# Get the actual path to node binary
NODE_PATH=$(which node)
echo "Using Node.js from: $NODE_PATH"

# Create service file with sudo
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
Environment=DEBUG=*
Environment=NODE_DEBUG=*
Environment=NODE_OPTIONS=\"--trace-warnings --experimental-specifier-resolution=node\"
EnvironmentFile=-/home/ec2-user/event-monitor/.env
ExecStart=${NODE_PATH} --experimental-specifier-resolution=node dist/run.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/event-monitor.log
StandardError=append:/var/log/event-monitor.error.log

# Ensure we have access to enough file descriptors
LimitNOFILE=65535

# Ensure proper PATH for Node.js and npm global modules
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/root/.local/share/pnpm:/home/ec2-user/.local/share/pnpm
Environment=NODE_PATH=/usr/lib/node_modules

[Install]
WantedBy=multi-user.target
EOF"

# Create log files with proper permissions
echo "Setting up log files..."
sudo touch /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chown ec2-user:ec2-user /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chmod 644 /var/log/event-monitor.log /var/log/event-monitor.error.log

# Test Node.js application
echo "Testing Node.js application..."
cd /home/ec2-user/event-monitor
echo "Running test with full debug output:"
NODE_ENV=staging DEBUG=* NODE_DEBUG=* NODE_OPTIONS="--trace-warnings --experimental-specifier-resolution=node" \
  AWS_REGION=us-east-1 node --experimental-specifier-resolution=node dist/run.js 2>&1 | tee /tmp/node-test.log &
PID=$!
sleep 5
echo "Test run output:"
cat /tmp/node-test.log
if ps -p $PID > /dev/null; then
    kill $PID || true
fi

# Check if test run had errors
if grep -i "error" /tmp/node-test.log; then
    echo "Test run encountered errors. Check the logs above."
    exit 1
fi

# Reload systemd daemon and start service
echo "Reloading systemd daemon..."
sudo systemctl daemon-reload
sudo systemctl enable event-monitor
sudo systemctl restart event-monitor

# Wait for service to start
sleep 5
sudo systemctl status event-monitor 