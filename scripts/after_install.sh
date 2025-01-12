#!/bin/bash

cd /home/ec2-user/event-monitor

# Install dependencies
pnpm install --prod

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
Environment=NODE_ENV=production
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/event-monitor
EnvironmentFile=/home/ec2-user/event-monitor/.env
ExecStart=/usr/bin/node dist/run.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd daemon
systemctl daemon-reload

# Set correct permissions
chown -R ec2-user:ec2-user /home/ec2-user/event-monitor 