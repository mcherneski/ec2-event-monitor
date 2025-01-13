#!/bin/bash

# Set up logging
exec 1> >(logger -s -t $(basename $0)) 2>&1

echo "Starting application stop script"

# For fresh deployments, the service file might not exist yet
if [ ! -f "/etc/systemd/system/event-listener.service" ]; then
    echo "No existing service file found - this appears to be a fresh deployment"
    exit 0
fi

echo "Checking if service exists in systemd"
if systemctl list-unit-files | grep -q event-listener; then
    echo "Service exists, checking if it's running"
    if systemctl is-active --quiet event-listener; then
        echo "Stopping event-listener service"
        systemctl stop event-listener
        echo "Service stopped"
    else
        echo "Service is not running"
    fi
    
    echo "Disabling event-listener service"
    systemctl disable event-listener
    echo "Service disabled"
else
    echo "Service does not exist in systemd"
fi

echo "Application stop script completed successfully"
exit 0 