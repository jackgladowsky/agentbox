#!/bin/bash

# AgentBox Status
# Quick status overview of AgentBox and the agent ecosystem

echo "=== AgentBox Status ==="
echo "Date: $(date)"
echo

# Check if daemon is running
PIDFILE="/tmp/agentbox_daemon.pid"
if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "✅ AgentBox Daemon: Running (PID: $(cat $PIDFILE))"
else
    echo "❌ AgentBox Daemon: Not running"
fi

# System health summary
echo
echo "=== System Health ==="
uptime | awk -F'load average:' '{printf "Load Average:%s\n", $2}'
free -h | awk 'NR==2{printf "Memory: %s/%s (%.1f%%)\n", $3,$2,$3*100/$2}'
df -h / | awk 'NR==2{printf "Main Disk: %s/%s (%s)\n", $3,$2,$5}'

# Agent services
echo
echo "=== Agent Ecosystem ==="
services=("clawdbot-gateway" "memory-engine" "kirkbot" "pantry-app")
for service in "${services[@]}"; do
    status=$(systemctl --user is-active "$service.service" 2>/dev/null || echo "not-found")
    if [ "$status" = "active" ]; then
        echo "✅ $service: Active"
    else
        echo "❌ $service: $status"
    fi
done

# Recent logs
echo
echo "=== Recent Activity ==="
if [ -f "/tmp/agentbox_daemon.log" ]; then
    echo "Last daemon activity:"
    tail -3 "/tmp/agentbox_daemon.log" | sed 's/^/  /'
else
    echo "No daemon logs found"
fi

echo
echo "=== Quick Actions ==="
echo "Start monitoring: ./scripts/agentbox_daemon.sh"
echo "Health check: ./scripts/system_health.sh"
echo "Clawdbot monitor: ./scripts/clawdbot_monitor.sh"