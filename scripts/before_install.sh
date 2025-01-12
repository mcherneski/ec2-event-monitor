#!/bin/bash
# Install node and pnpm if not already installed
if ! command -v node &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
fi

if ! command -v pnpm &> /dev/null; then
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    source ~/.bashrc
fi

# Create application directory if it doesn't exist
if [ ! -d "/home/ec2-user/event-monitor" ]; then
    mkdir -p /home/ec2-user/event-monitor
fi

# Clean up existing files if any
rm -rf /home/ec2-user/event-monitor/* 