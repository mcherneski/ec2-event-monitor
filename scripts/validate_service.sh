#!/bin/bash

# Check if service is running
if ! systemctl is-active --quiet event-monitor; then
    echo "event-monitor service is not running"
    exit 1
fi

echo "Service validation successful"
exit 0 