#!/bin/bash

cd /home/ec2-user/event-monitor

# Install production dependencies
pnpm install --prod

# Ensure dist directory exists and has correct permissions
mkdir -p dist
chown -R ec2-user:ec2-user .

# Fetch environment variables from SSM Parameter Store and create .env file
aws ssm get-parameters-by-path \
    --path "/event-monitor/${NODE_ENV:-dev}" \
    --with-decryption \
    --region us-east-1 \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
    # Extract parameter name after the last '/'
    param_name=$(echo "$name" | rev | cut -d'/' -f1 | rev)
    echo "${param_name}=${value}" >> .env
done

# Create systemd service file
cat > /etc/systemd/system/event-listener.service << 'EOF'
[Unit]
Description=Blockchain Event Listener
After=network.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/event-monitor
Environment=NODE_ENV=production
EnvironmentFile=/home/ec2-user/event-monitor/.env
ExecStart=/usr/bin/node /home/ec2-user/event-monitor/dist/run.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/event-listener.log
StandardError=append:/var/log/event-listener.error.log

[Install]
WantedBy=multi-user.target
EOF

# Create log files with proper permissions
touch /var/log/event-listener.log /var/log/event-listener.error.log
chown ec2-user:ec2-user /var/log/event-listener.log /var/log/event-listener.error.log

# Reload systemd daemon
systemctl daemon-reload 