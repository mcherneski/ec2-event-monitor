#!/bin/bash

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

# Check file permissions
echo "File permissions:"
ls -la /home/ec2-user/event-monitor/dist/
ls -la /home/ec2-user/event-monitor/

# Enable and start the service
systemctl enable event-listener
systemctl start event-listener

# Wait for service to start
sleep 5

# Print service status and logs
echo "Service status:"
systemctl status event-listener
echo "Service logs:"
journalctl -u event-listener --no-pager -n 50

# Check if service is running
if ! systemctl is-active --quiet event-listener; then
    echo "Failed to start event-listener service"
    exit 1
fi 