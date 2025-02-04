#!/bin/bash

# Check Node.js version requirement
required_version="v18"
current_version=$(node --version)
if [[ ! $current_version == *"$required_version"* ]]; then
    echo "Error: Node.js version 18.x is required. Current version: $current_version"
    echo "Installing Node.js 18..."
    sudo dnf install -y nodejs
    current_version=$(node --version)
    echo "Installed Node.js version: $current_version"
fi

# Print service file contents for debugging
echo "Service file contents:"
cat /etc/systemd/system/event-listener.service

# Check if the executable exists
if [ ! -f "/home/ec2-user/event-monitor/dist/run.js" ]; then
    echo "Error: /home/ec2-user/event-monitor/dist/run.js not found"
    ls -la /home/ec2-user/event-monitor/dist/
    exit 1
fi

# Check Node.js installation
echo "Node.js version:"
node --version
which node

# Check file permissions and contents
echo "File permissions and contents:"
ls -la /home/ec2-user/event-monitor/dist/
ls -la /home/ec2-user/event-monitor/
echo "Contents of run.js:"
cat /home/ec2-user/event-monitor/dist/run.js

# Test running the application directly with debug output
echo "Testing Node.js application directly:"
cd /home/ec2-user/event-monitor
echo "Running with node directly:"
sudo -u ec2-user NODE_ENV=staging DEBUG=* node --trace-warnings dist/run.js 2>&1 | tee /tmp/node-test.log &
PID=$!
sleep 5
echo "Test run output:"
cat /tmp/node-test.log
kill $! || true

# Check environment file
echo "Environment file contents (excluding sensitive data):"
grep -v "KEY\|SECRET\|PASSWORD" /home/ec2-user/event-monitor/.env || echo "No .env file found"

# Check error log if it exists
echo "Checking previous error log:"
if [ -f "/var/log/event-listener.error.log" ]; then
    tail -n 50 /var/log/event-listener.error.log
else
    echo "No error log found"
fi

# Enable and start the service
systemctl enable event-listener
systemctl start event-listener

sleep 5

# Check if service is running
if ! systemctl is-active --quiet event-listener; then
    echo "Failed to start event-listener service"
    echo "Latest error log:"
    tail -n 50 /var/log/event-listener.error.log
    exit 1
fi 