#!/bin/bash
set -e

# Basic logging to a file
LOGFILE="/tmp/before_install.log"
exec 1> >(tee -a "$LOGFILE") 2>&1

echo "Starting before_install.sh"

# Stop the existing service and kill any processes on port 3000
echo "Stopping existing service and cleaning up processes..."
sudo systemctl stop event-monitor || true
sudo systemctl disable event-monitor || true

# Find and kill any process using port 3000
if lsof -i :3000 > /dev/null; then
    echo "Found process using port 3000. Killing it..."
    sudo lsof -t -i:3000 | xargs sudo kill -9 || true
fi

# Detect and install packages
if grep -q "Amazon Linux 2023" /etc/os-release; then
    sudo dnf update -y
    sudo dnf install -y nodejs nodejs-devel npm gcc-c++ make lsof
elif grep -q "Amazon Linux 2" /etc/os-release; then
    curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs lsof
else
    echo "Unsupported OS version"
    exit 1
fi

# Create application directory
sudo mkdir -p /home/ec2-user/event-monitor
sudo chown ec2-user:ec2-user /home/ec2-user/event-monitor
sudo rm -rf /home/ec2-user/event-monitor/*

# Create and set permissions for log directory
sudo mkdir -p /var/log/event-listener
sudo chown -R ec2-user:ec2-user /var/log/event-listener
sudo chmod 755 /var/log/event-listener

# Clean up any existing service files
sudo rm -f /etc/systemd/system/event-monitor.service
sudo systemctl daemon-reload

# Set up npm global directory
sudo mkdir -p /usr/local/lib/node_modules
sudo chmod 777 /usr/local/lib/node_modules

# Configure npm
cd /home/ec2-user
npm config set prefix '/usr/local'

# Update PATH
echo 'export PATH="/usr/local/bin:$PATH"' >> /home/ec2-user/.bashrc

# Verify Node.js and npm installation
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

echo "before_install.sh completed" 