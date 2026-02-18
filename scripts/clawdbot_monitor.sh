#!/bin/bash

# Clawdbot Health Monitor
# Monitors Discord connection issues and provides recovery options

LOG_FILE="/tmp/clawdbot_monitor.log"
ERROR_THRESHOLD=20  # Number of 1005 errors in 5 minutes before action
CHECK_INTERVAL=300  # 5 minutes

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

check_discord_errors() {
    local since_time=$(date -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S')
    local error_count
    
    error_count=$(journalctl --user -u clawdbot-gateway.service --since "$since_time" | grep -c "WebSocket connection closed with code 1005" || echo "0")
    echo "$error_count"
}

get_service_status() {
    systemctl --user is-active clawdbot-gateway.service 2>/dev/null
}

restart_clawdbot() {
    log "RESTART: Restarting clawdbot-gateway.service due to excessive Discord errors"
    systemctl --user restart clawdbot-gateway.service
    
    if [ $? -eq 0 ]; then
        log "RESTART: Successfully restarted clawdbot-gateway.service"
        return 0
    else
        log "RESTART: Failed to restart clawdbot-gateway.service"
        return 1
    fi
}

main() {
    log "MONITOR: Starting Clawdbot health check"
    
    local service_status=$(get_service_status)
    log "MONITOR: Service status: $service_status"
    
    if [ "$service_status" != "active" ]; then
        log "ALERT: Clawdbot service is not active!"
        exit 1
    fi
    
    local error_count=$(check_discord_errors)
    log "MONITOR: Discord 1005 errors in last 5 minutes: $error_count"
    
    if [ "$error_count" -gt "$ERROR_THRESHOLD" ]; then
        log "ALERT: Discord error count ($error_count) exceeds threshold ($ERROR_THRESHOLD)"
        
        # Check if we restarted recently (avoid restart loops)
        local last_restart=$(journalctl --user -u clawdbot-gateway.service --since '1 hour ago' | grep -c "Started Clawdbot Gateway" || echo "0")
        
        if [ "$last_restart" -lt 3 ]; then
            restart_clawdbot
        else
            log "ALERT: Too many restarts in the last hour, manual intervention required"
        fi
    else
        log "MONITOR: Discord connection errors within acceptable range"
    fi
}

# Run the check
main

# If running in daemon mode, continue monitoring
if [ "$1" = "--daemon" ]; then
    log "DAEMON: Starting continuous monitoring (interval: ${CHECK_INTERVAL}s)"
    while true; do
        sleep "$CHECK_INTERVAL"
        main
    done
fi