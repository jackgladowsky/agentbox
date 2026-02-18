#!/bin/bash

# AgentBox System Health Monitor
# Comprehensive health check for the AI agent ecosystem

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
HEALTH_LOG="/tmp/system_health.log"

log() {
    echo "[$TIMESTAMP] $1" | tee -a "$HEALTH_LOG"
}

# System Resources
check_resources() {
    log "=== SYSTEM RESOURCES ==="
    
    # Load average
    local load=$(uptime | awk -F'load average:' '{print $2}')
    log "Load Average:$load"
    
    # Memory
    local mem_info=$(free -h | awk 'NR==2{printf "Memory: %s/%s (%.1f%%)", $3,$2,$3*100/$2}')
    log "$mem_info"
    
    # Disk space
    local disk_main=$(df -h / | awk 'NR==2{printf "Main Disk: %s/%s (%s)", $3,$2,$5}')
    local disk_storage=$(df -h /mnt/storage | awk 'NR==2{printf "Storage: %s/%s (%s)", $3,$2,$5}')
    log "$disk_main"
    log "$disk_storage"
}

# Agent Services Status
check_agent_services() {
    log "=== AGENT SERVICES ==="
    
    local services=("clawdbot-gateway" "memory-engine" "kirkbot" "pantry-app")
    
    for service in "${services[@]}"; do
        local status=$(systemctl --user is-active "$service.service" 2>/dev/null || echo "not-found")
        local uptime=""
        
        if [ "$status" = "active" ]; then
            uptime=$(systemctl --user show "$service.service" --property=ActiveEnterTimestamp --value)
            uptime=$(date -d "$uptime" '+%s')
            local now=$(date '+%s')
            local duration=$((now - uptime))
            uptime=" (up ${duration}s)"
        fi
        
        log "Service $service: $status$uptime"
    done
}

# Process Analysis
check_top_processes() {
    log "=== TOP PROCESSES BY CPU ==="
    ps aux --sort=-%cpu | head -6 | while read line; do
        if [[ $line == *"USER"* ]]; then
            continue
        fi
        local cpu=$(echo "$line" | awk '{print $3}')
        local mem=$(echo "$line" | awk '{print $4}')  
        local cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}' | cut -c1-60)
        log "Process: ${cpu}% CPU, ${mem}% MEM - $cmd"
    done
}

# Network Connectivity  
check_network() {
    log "=== NETWORK CONNECTIVITY ==="
    
    # Discord API
    local discord_status=$(curl -s -o /dev/null -w "%{http_code}" https://discord.com/api/v10/gateway --max-time 5)
    log "Discord API: HTTP $discord_status"
    
    # Anthropic API
    local anthropic_status=$(curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/messages --max-time 5)
    log "Anthropic API: HTTP $anthropic_status"
    
    # GitHub
    local github_status=$(curl -s -o /dev/null -w "%{http_code}" https://api.github.com --max-time 5)
    log "GitHub API: HTTP $github_status"
}

# Agent-specific Health
check_clawdbot_health() {
    log "=== CLAWDBOT HEALTH ==="
    
    # Recent Discord errors
    local discord_errors=$(journalctl --user -u clawdbot-gateway.service --since "10 minutes ago" | grep -c "WebSocket connection closed with code 1005" || echo "0")
    log "Discord 1005 errors (10min): $discord_errors"
    
    # Memory usage
    local memory=$(ps -eo pid,comm,%mem --sort=-%mem | grep clawdbot | head -1 | awk '{print $3}')
    log "Clawdbot memory usage: ${memory}%"
    
    # Chrome processes
    local chrome_count=$(ps aux | grep -c "chrome.*clawdbot" || echo "0")
    log "Chrome processes: $chrome_count"
}

# Storage Analysis
check_storage_opportunities() {
    log "=== STORAGE ANALYSIS ==="
    
    # Large directories
    log "Largest directories in /home/jack:"
    du -sh /home/jack/* 2>/dev/null | sort -hr | head -5 | while read size dir; do
        log "  $size - $(basename $dir)"
    done
    
    # Available space on storage drive
    local storage_free=$(df -h /mnt/storage | awk 'NR==2{print $4}')
    log "Storage drive free space: $storage_free"
}

# Generate Health Summary
generate_summary() {
    log "=== HEALTH SUMMARY ==="
    
    # Overall status
    local load_1min=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
    local mem_percent=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
    
    if (( $(echo "$load_1min < 1.0" | bc -l) )) && (( mem_percent < 80 )); then
        log "System Status: HEALTHY"
    elif (( $(echo "$load_1min < 2.0" | bc -l) )) && (( mem_percent < 90 )); then
        log "System Status: MODERATE"
    else
        log "System Status: STRESSED"
    fi
    
    # Agent ecosystem status
    local active_agents=$(systemctl --user list-units --state=active | grep -E "(clawdbot|kirkbot|memory-engine)" | wc -l)
    log "Active AI agents: $active_agents"
    
    # Recommendations
    if [ "$discord_errors" -gt 15 ]; then
        log "RECOMMENDATION: Consider restarting clawdbot-gateway (high Discord errors)"
    fi
    
    if (( mem_percent > 85 )); then
        log "RECOMMENDATION: Monitor memory usage, consider cleanup"
    fi
}

# Main execution
main() {
    log "AgentBox System Health Check - Starting"
    check_resources
    check_agent_services  
    check_top_processes
    check_network
    check_clawdbot_health
    check_storage_opportunities
    generate_summary
    log "Health check completed"
}

# Run the health check
main