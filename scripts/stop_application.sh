#!/bin/bash
# Stop the service if it's running
if systemctl is-active --quiet event-listener; then
    systemctl stop event-listener
fi

# Disable the service
systemctl disable event-listener 