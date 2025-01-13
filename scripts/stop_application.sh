#!/bin/bash
# Check if the service exists
if systemctl list-unit-files | grep -q event-listener; then
    # Stop the service if it's running
    if systemctl is-active --quiet event-listener; then
        systemctl stop event-listener
    fi
    # Disable the service
    systemctl disable event-listener
fi

# Always exit successfully
exit 0 