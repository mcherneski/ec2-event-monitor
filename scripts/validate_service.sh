#!/bin/bash

# Check if service is running
if ! systemctl is-active --quiet event-listener; then
    echo "event-listener service is not running"
    exit 1
fi

# Check if application is responding on health check endpoint
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
if [ "$response" != "200" ]; then
    echo "Health check failed with response code: $response"
    exit 1
fi

echo "Service validation successful"
exit 0 