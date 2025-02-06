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
rm -rf node_modules
npm install --production

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
NODE_ENV=staging
AWS_REGION=us-east-1
AWS_SDK_LOAD_CONFIG=1
EOL

# Fetch environment variables from SSM
echo "Fetching environment variables from SSM..."
aws ssm get-parameters-by-path \
    --path "/ngu-points-system-v2/staging" \
    --with-decryption \
    --region us-east-1 \
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

# Create systemd service file
NODE_PATH=$(which node)
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
EnvironmentFile=-/home/ec2-user/event-monitor/.env
ExecStart=${NODE_PATH} dist/run.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/event-monitor.log
StandardError=append:/var/log/event-monitor.error.log

[Install]
WantedBy=multi-user.target
EOF"

# Set up log files
sudo touch /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chown ec2-user:ec2-user /var/log/event-monitor.log /var/log/event-monitor.error.log
sudo chmod 644 /var/log/event-monitor.log /var/log/event-monitor.error.log

# Start the service
sudo systemctl daemon-reload
sudo systemctl enable event-monitor
sudo systemctl restart event-monitor

# Wait and check status
sleep 5
sudo systemctl status event-monitor 