#!/bin/bash
# Enable and start the service
systemctl enable event-listener
systemctl start event-listener

# Wait for service to start
sleep 5

# Check if service is running
if ! systemctl is-active --quiet event-listener; then
    echo "Failed to start event-listener service"
    exit 1
fi 