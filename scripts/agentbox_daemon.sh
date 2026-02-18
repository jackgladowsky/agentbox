#!/bin/bash

# AgentBox Daemon
# Autonomous monitoring and maintenance daemon

DAEMON_LOG="/tmp/agentbox_daemon.log"
SCRIPT_DIR="/home/jack/agentbox/scripts"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] DAEMON: $1" | tee -a "$DAEMON_LOG"
}

# Health check every 5 minutes
run_health_check() {
    log "Running system health check"
    "$SCRIPT_DIR/system_health.sh" >> "$DAEMON_LOG" 2>&1
}

# Clawdbot monitoring every 2 minutes  
run_clawdbot_monitor() {
    log "Running Clawdbot health monitor"
    "$SCRIPT_DIR/clawdbot_monitor.sh" >> "$DAEMON_LOG" 2>&1
}

# Log rotation (daily)
rotate_logs() {
    local max_size=10485760  # 10MB
    
    for logfile in "$DAEMON_LOG" "/tmp/system_health.log" "/tmp/clawdbot_monitor.log"; do
        if [ -f "$logfile" ] && [ $(stat -c%s "$logfile") -gt $max_size ]; then
            log "Rotating log file: $logfile"
            mv "$logfile" "${logfile}.old"
            touch "$logfile"
        fi
    done
}

# Main daemon loop
main() {
    log "AgentBox Daemon starting - PID: $$"
    
    local health_counter=0
    local clawdbot_counter=0
    local rotation_counter=0
    
    while true; do
        # Health check every 5 minutes (300 seconds / 30 = 10 cycles)
        if [ $((health_counter % 10)) -eq 0 ]; then
            run_health_check
        fi
        
        # Clawdbot monitor every 2 minutes (120 seconds / 30 = 4 cycles)  
        if [ $((clawdbot_counter % 4)) -eq 0 ]; then
            run_clawdbot_monitor
        fi
        
        # Log rotation every hour (3600 seconds / 30 = 120 cycles)
        if [ $((rotation_counter % 120)) -eq 0 ]; then
            rotate_logs
        fi
        
        # Increment counters
        health_counter=$((health_counter + 1))
        clawdbot_counter=$((clawdbot_counter + 1))
        rotation_counter=$((rotation_counter + 1))
        
        # Sleep for 30 seconds between cycles
        sleep 30
    done
}

# Signal handlers for graceful shutdown
cleanup() {
    log "Received shutdown signal, cleaning up..."
    exit 0
}

trap cleanup SIGTERM SIGINT

# Check if already running
PIDFILE="/tmp/agentbox_daemon.pid"
if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
    echo "AgentBox Daemon is already running (PID: $(cat $PIDFILE))"
    exit 1
fi

# Write PID file
echo $$ > "$PIDFILE"

# Start daemon
if [ "$1" = "--foreground" ]; then
    main
else
    # Run in background
    main &
    log "AgentBox Daemon started in background (PID: $!)"
fi