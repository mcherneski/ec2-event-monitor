#!/bin/bash
set -e  # Exit on error

# Install Node.js if not already installed
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    
    # Check which package manager is available
    if command -v dnf &> /dev/null; then
        echo "Using dnf package manager..."
        dnf install -y nodejs
    elif command -v yum &> /dev/null; then
        echo "Using yum package manager..."
        curl -sL https://rpm.nodesource.com/setup_18.x | bash -
        yum install -y nodejs
    else
        echo "No supported package manager found"
        exit 1
    fi

    # Create symlink if needed
    if [ ! -f "/usr/bin/node" ] && [ -f "/usr/local/bin/node" ]; then
        ln -s /usr/local/bin/node /usr/bin/node
    fi
fi

# Verify Node.js installation
echo "Node.js version:"
node --version
which node

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
echo "Node.js binary location:"
ls -l /usr/bin/node* || true
ls -l /usr/local/bin/node* || true 