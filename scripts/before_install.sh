#!/bin/bash
set -e  # Exit on error

# Debug system information
echo "System information:"
cat /etc/os-release
echo "Available package managers:"
if command -v dnf &> /dev/null; then
    echo "Found dnf"
else
    echo "No dnf found"
fi
echo "PATH=$PATH"

# Install Node.js 18.x
echo "Installing Node.js 18.x..."
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:18 -y
sudo dnf install -y nodejs

# Verify Node.js installation
echo "Node.js version:"
node --version
which node
echo "npm version:"
npm --version
which npm

# Create ec2-user if it doesn't exist
if ! id "ec2-user" &>/dev/null; then
    useradd -m -s /bin/bash ec2-user
    # Add ec2-user to sudoers
    echo "ec2-user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ec2-user
fi

# Create application directory if it doesn't exist
if [ ! -d "/home/ec2-user/event-monitor" ]; then
    mkdir -p /home/ec2-user/event-monitor
    chown ec2-user:ec2-user /home/ec2-user/event-monitor
fi

# Clean up existing files if any
rm -rf /home/ec2-user/event-monitor/*

# Install pnpm
echo "Installing pnpm..."
npm install -g pnpm

# Verify pnpm installation
pnpm --version 