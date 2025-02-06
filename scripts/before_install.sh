#!/bin/bash
#Version 0.0.02 

# Enable error handling and logging
set -e  # Exit on error
exec 1> >(logger -s -t $(basename $0)) 2>&1  # Log all output

# Create a log file that we can definitely write to
LOGFILE="/tmp/before_install.log"
touch $LOGFILE
exec 1> >(tee -a "$LOGFILE") 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting before_install.sh script"

# Debug system information
echo "System information:"
cat /etc/os-release
echo "Current user: $(whoami)"
echo "Current directory: $(pwd)"
echo "Detecting package manager..."

# Ensure we're in a valid directory
cd /tmp
echo "Changed to directory: $(pwd)"

# Function to log and exit on error
error_exit() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: $1" | tee -a "$LOGFILE"
    exit 1
}

# Detect Amazon Linux version and package manager
if grep -q "Amazon Linux 2023" /etc/os-release; then
    echo "Amazon Linux 2023 detected, using dnf"
    # Install Node.js 18.x for AL2023
    sudo dnf update -y || error_exit "Failed to update system packages"
    sudo dnf install -y nodejs nodejs-devel npm gcc-c++ make || error_exit "Failed to install Node.js and dependencies"
elif grep -q "Amazon Linux 2" /etc/os-release; then
    echo "Amazon Linux 2 detected, using yum"
    # Install Node.js 18.x for AL2
    curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash - || error_exit "Failed to setup Node.js repository"
    sudo yum install -y nodejs || error_exit "Failed to install Node.js"
else
    error_exit "Unsupported OS version"
fi

# Verify Node.js installation
echo "Node.js version:"
node --version || error_exit "Node.js not installed correctly"
which node || error_exit "Node.js not in PATH"
echo "npm version:"
npm --version || error_exit "npm not installed correctly"
which npm || error_exit "npm not in PATH"

# Create ec2-user if it doesn't exist (should already exist on Amazon Linux)
if ! id "ec2-user" &>/dev/null; then
    echo "Creating ec2-user..."
    useradd -m -s /bin/bash ec2-user || error_exit "Failed to create ec2-user"
    # Add ec2-user to sudoers
    echo "ec2-user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ec2-user || error_exit "Failed to set up ec2-user sudo access"
fi

# Create application directory if it doesn't exist
echo "Creating application directory..."
sudo mkdir -p /home/ec2-user/event-monitor || error_exit "Failed to create event-monitor directory"
sudo chown ec2-user:ec2-user /home/ec2-user/event-monitor || error_exit "Failed to set directory ownership"

# Clean up existing files if any
echo "Cleaning up existing files..."
sudo rm -rf /home/ec2-user/event-monitor/* || error_exit "Failed to clean up existing files"

# Create a temporary directory for npm global installations
echo "Setting up npm global directory..."
sudo mkdir -p /usr/local/lib/node_modules || error_exit "Failed to create node_modules directory"
sudo chmod 777 /usr/local/lib/node_modules || error_exit "Failed to set permissions on node_modules"

# Install pnpm globally with explicit prefix
echo "Installing pnpm..."
cd /home/ec2-user || error_exit "Failed to change to ec2-user home directory"
npm config set prefix '/usr/local' || error_exit "Failed to set npm prefix"

echo "Attempting to install pnpm globally..."
npm install -g pnpm || {
    echo "Failed to install pnpm globally. Trying alternative method..."
    curl -fsSL https://get.pnpm.io/install.sh | sh - || error_exit "Both pnpm installation methods failed"
}

# Set up pnpm for ec2-user
echo "Setting up pnpm for ec2-user..."
sudo -u ec2-user bash -c 'mkdir -p ~/.local/share/pnpm' || error_exit "Failed to create pnpm directory"

# Update bashrc with environment variables
echo "Updating bashrc..."
{
    echo 'export PNPM_HOME="/home/ec2-user/.local/share/pnpm"'
    echo 'export PATH="$PNPM_HOME:$PATH"'
    echo 'export PATH="/usr/local/bin:$PATH"'
} | sudo tee -a /home/ec2-user/.bashrc || error_exit "Failed to update bashrc"

# Source the updated bashrc
source /home/ec2-user/.bashrc || error_exit "Failed to source bashrc"

# Verify pnpm installation
echo "Verifying pnpm installation..."
which pnpm || echo "pnpm not found in PATH"
pnpm --version || echo "Failed to get pnpm version"

# List all relevant directories and permissions
echo "Directory permissions:"
ls -la /home/ec2-user/event-monitor
ls -la /usr/local/lib/node_modules
ls -la /home/ec2-user/.local/share/pnpm || echo "pnpm directory not found"

echo "$(date '+%Y-%m-%d %H:%M:%S') before_install.sh script completed successfully" 