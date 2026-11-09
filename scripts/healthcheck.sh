#!/usr/bin/env bash
set -euo pipefail

curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18081/health
test -r /etc/logrotate.d/streamhub
node -e "const value=require('/opt/StreamHub/server/lib/logManager').RETENTION_MS; process.exit(value === 7 * 24 * 60 * 60 * 1000 ? 0 : 1)"
if [[ "$(id -u)" -eq 0 ]]; then
  runuser -u streamhub -- nginx -t -c /opt/StreamHub/services/nginx-rtmp.conf -p /opt/StreamHub >/dev/null
else
  nginx -t -c /opt/StreamHub/services/nginx-rtmp.conf -p /opt/StreamHub >/dev/null
fi
