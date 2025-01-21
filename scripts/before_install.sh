#!/bin/bash
#Version 0.0.01 
set -e  # Exit on error

# Debug system information
echo "System information:"
cat /etc/os-release
echo "Detecting package manager..."

# Detect Amazon Linux version and package manager
if grep -q "Amazon Linux 2023" /etc/os-release; then
    echo "Amazon Linux 2023 detected, using dnf"
    # Install Node.js 18.x for AL2023
    sudo dnf update -y
    sudo dnf install -y nodejs nodejs-devel npm gcc-c++ make
elif grep -q "Amazon Linux 2" /etc/os-release; then
    echo "Amazon Linux 2 detected, using yum"
    # Install Node.js 18.x for AL2
    curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
else
    echo "Unsupported OS version"
    exit 1
fi

# Verify Node.js installation
echo "Node.js version:"
node --version
which node
echo "npm version:"
npm --version
which npm

# Create ec2-user if it doesn't exist (should already exist on Amazon Linux)
if ! id "ec2-user" &>/dev/null; then
    useradd -m -s /bin/bash ec2-user
    # Add ec2-user to sudoers
    echo "ec2-user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ec2-user
fi

# Create application directory if it doesn't exist
sudo mkdir -p /home/ec2-user/event-monitor
sudo chown ec2-user:ec2-user /home/ec2-user/event-monitor

# Clean up existing files if any
sudo rm -rf /home/ec2-user/event-monitor/*

# Install pnpm globally
echo "Installing pnpm..."
sudo npm install -g pnpm

# Set up pnpm for ec2-user
sudo -u ec2-user bash -c 'mkdir -p ~/.local/share/pnpm'
echo 'export PNPM_HOME="/home/ec2-user/.local/share/pnpm"' | sudo tee -a /home/ec2-user/.bashrc
echo 'export PATH="$PNPM_HOME:$PATH"' | sudo tee -a /home/ec2-user/.bashrc

# Verify pnpm installation
echo "pnpm version:"
pnpm --version 