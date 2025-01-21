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
touch .env
sudo chown ec2-user:ec2-user .env
chmod 644 .env

echo "Fetching environment variables from SSM..."
# Fetch environment variables from SSM Parameter Store and create .env file
aws ssm get-parameters-by-path \
    --path "/event-monitor/${NODE_ENV:-dev}" \
    --with-decryption \
    --region us-east-1 \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
    # Extract parameter name after the last '/'
    param_name=$(echo "$name" | rev | cut -d'/' -f1 | rev)
    echo "$param_name=$value" >> .env
done

# Verify .env file was created
if [ ! -s .env ]; then
    echo "Warning: .env file is empty or was not created"
fi

echo "After install completed successfully"

# Create systemd service file
echo "Creating systemd service file..."
# Get the actual path to node binary
NODE_PATH=$(which node)
echo "Using Node.js from: $NODE_PATH"

cat > /etc/systemd/system/event-listener.service << EOF
[Unit]
Description=Blockchain Event Listener
After=network.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/event-monitor
Environment=NODE_ENV=production
Environment=DEBUG=*
Environment=NODE_DEBUG=*
Environment=NODE_OPTIONS=--trace-warnings
EnvironmentFile=-/home/ec2-user/event-monitor/.env
ExecStart=/bin/sh -c '${NODE_PATH} dist/run.js 2>&1 | tee -a /var/log/event-listener.error.log'
Restart=always
RestartSec=10
StandardOutput=append:/var/log/event-listener.log
StandardError=append:/var/log/event-listener.error.log

# Ensure we have access to enough file descriptors
LimitNOFILE=65535

# Ensure proper PATH for Node.js and npm global modules
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/root/.local/share/pnpm:/home/ec2-user/.local/share/pnpm
Environment=NODE_PATH=/usr/lib/node_modules

[Install]
WantedBy=multi-user.target
EOF

# Create log files with proper permissions
echo "Setting up log files..."
touch /var/log/event-listener.log /var/log/event-listener.error.log
sudo chown ec2-user:ec2-user /var/log/event-listener.log /var/log/event-listener.error.log
sudo chmod 644 /var/log/event-listener.log /var/log/event-listener.error.log

# Test Node.js application
echo "Testing Node.js application..."
cd /home/ec2-user/event-monitor
echo "Running test with full debug output:"
sudo -u ec2-user NODE_ENV=production DEBUG=* NODE_DEBUG=* node --trace-warnings dist/run.js 2>&1 | tee /tmp/node-test.log &
PID=$!
sleep 5
echo "Test run output:"
cat /tmp/node-test.log
kill $PID || true

# Reload systemd daemon
echo "Reloading systemd daemon..."
sudo systemctl daemon-reload 