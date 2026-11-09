#!/usr/bin/env bash
set -euo pipefail

APP_SERVICE=streamhub.service
RTMP_SERVICE=streamhub-rtmp.service

case "${1:-status}" in
  start)
    systemctl start "${APP_SERVICE}"
    systemctl start "${RTMP_SERVICE}"
    ;;
  stop)
    systemctl stop "${RTMP_SERVICE}" || true
    systemctl stop "${APP_SERVICE}"
    ;;
  restart)
    systemctl restart "${APP_SERVICE}"
    systemctl restart "${RTMP_SERVICE}"
    ;;
  status)
    systemctl --no-pager --full status "${APP_SERVICE}" "${RTMP_SERVICE}"
    ;;
  logs)
    journalctl -u "${APP_SERVICE}" -u "${RTMP_SERVICE}" -f
    ;;
  rtmp-test)
    runuser -u streamhub -- nginx -t -c /opt/StreamHub/services/nginx-rtmp.conf -p /opt/StreamHub
    ;;
  test)
    cd /opt/StreamHub
    npm test
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|rtmp-test|test}"
    exit 2
    ;;
esac
