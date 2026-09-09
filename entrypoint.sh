#!/bin/sh
missing=0

LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-${RAILWAY_TCP_PROXY_PORT:-}}"
RAILWAY_PROXY_TARGET_PORT="${RAILWAY_PROXY_TARGET_PORT:-${RAILWAY_TCP_APPLICATION_PORT:-}}"
export LIVEKIT_TCP_PORT RAILWAY_PROXY_TARGET_PORT

require_env() {
    var="$1"
    eval "value=\${$var:-}"
    if [ -z "$value" ]; then
        echo "[entrypoint] missing required env: $var" >&2
        missing=1
    fi
}

for var in LIVEKIT_TCP_PORT RAILWAY_PROXY_TARGET_PORT LIVEKIT_API_KEY LIVEKIT_API_SECRET REDIS_ADDRESS; do
    require_env "$var"
done

if [ -z "${LIVEKIT_NODE_IP:-}" ]; then
    LIVEKIT_TCP_PROXY_HOST="${LIVEKIT_TCP_PROXY_HOST:-${RAILWAY_TCP_PROXY_HOST:-${RAILWAY_TCP_PROXY_DOMAIN:-}}}"
    if [ -z "$LIVEKIT_TCP_PROXY_HOST" ]; then
        echo "[entrypoint] missing required env: LIVEKIT_NODE_IP or LIVEKIT_TCP_PROXY_HOST" >&2
        missing=1
    else
        LIVEKIT_NODE_IP="$(getent hosts "$LIVEKIT_TCP_PROXY_HOST" | awk '/^[0-9]+\./ { print $1; exit }')"
        if [ -z "$LIVEKIT_NODE_IP" ]; then
            echo "[entrypoint] failed to resolve LIVEKIT_TCP_PROXY_HOST=$LIVEKIT_TCP_PROXY_HOST" >&2
            missing=1
        else
            export LIVEKIT_NODE_IP
            echo "[entrypoint] resolved LIVEKIT_NODE_IP=$LIVEKIT_NODE_IP from LIVEKIT_TCP_PROXY_HOST=$LIVEKIT_TCP_PROXY_HOST" >&2
        fi
    fi
else
    export LIVEKIT_NODE_IP
fi

if [ "$missing" -eq 1 ]; then
    exit 1
fi

export REDIS_PASSWORD="${REDIS_PASSWORD:-}"

# Bridge Railway's target port → LiveKit's advertised TCP port.
# Railway TCP Proxy assigns a random external port but forwards to RAILWAY_PROXY_TARGET_PORT.
# LiveKit must listen on LIVEKIT_TCP_PORT (= external port) to match its ICE candidates.
if [ "$RAILWAY_PROXY_TARGET_PORT" != "$LIVEKIT_TCP_PORT" ]; then
    socat -d -d TCP-LISTEN:${RAILWAY_PROXY_TARGET_PORT},fork,reuseaddr TCP:127.0.0.1:${LIVEKIT_TCP_PORT} &
    SOCAT_PID=$!
    echo "[entrypoint] socat bridge started: pid=$SOCAT_PID ports=${RAILWAY_PROXY_TARGET_PORT}->${LIVEKIT_TCP_PORT}" >&2
else
    echo "[entrypoint] socat skipped: target=${RAILWAY_PROXY_TARGET_PORT} == livekit=${LIVEKIT_TCP_PORT}" >&2
fi

envsubst '$LIVEKIT_TCP_PORT $LIVEKIT_NODE_IP $LIVEKIT_API_KEY $LIVEKIT_API_SECRET $REDIS_ADDRESS $REDIS_PASSWORD' < /etc/livekit.yaml.template > /tmp/livekit.yaml

chmod 600 /tmp/livekit.yaml

exec /livekit-server --config /tmp/livekit.yaml
