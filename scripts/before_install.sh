#!/bin/bash
set -e  # Exit on error

# Debug system information
echo "System information:"
cat /etc/os-release
echo "Available package managers:"
which apt apt-get 2>/dev/null || echo "No common package managers found"
echo "PATH=$PATH"

# Install Node.js 18.x
echo "Installing Node.js 18.x..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Create symlinks if needed
if [ ! -f "/usr/bin/node" ]; then
    echo "Creating symlink for node..."
    sudo ln -s $(which node) /usr/bin/node
fi

if [ ! -f "/usr/bin/npm" ]; then
    echo "Creating symlink for npm..."
    sudo ln -s $(which npm) /usr/bin/npm
fi

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

# Debug: Show installed binaries
echo "Node.js binary locations:"
ls -l /usr/bin/node* || true
ls -l /usr/local/bin/node* || true 