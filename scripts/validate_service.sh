#!/bin/bash

# Check if service is running
if ! systemctl is-active --quiet event-listener; then
    echo "event-listener service is not running"
    exit 1
fi

echo "Service validation successful"
exit 0 