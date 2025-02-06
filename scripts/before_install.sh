#!/bin/bash
set -e

# Basic logging to a file
LOGFILE="/tmp/before_install.log"
exec 1> >(tee -a "$LOGFILE") 2>&1

echo "Starting before_install.sh"

# Detect and install packages
if grep -q "Amazon Linux 2023" /etc/os-release; then
    sudo dnf update -y
    sudo dnf install -y nodejs nodejs-devel npm gcc-c++ make
elif grep -q "Amazon Linux 2" /etc/os-release; then
    curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
else
    echo "Unsupported OS version"
    exit 1
fi

# Create application directory
sudo mkdir -p /home/ec2-user/event-monitor
sudo chown ec2-user:ec2-user /home/ec2-user/event-monitor
sudo rm -rf /home/ec2-user/event-monitor/*

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