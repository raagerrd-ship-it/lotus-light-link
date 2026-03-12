# Sonos Local UPnP Proxy

Ultra-low latency (~10ms RTT) playback position for Lotus Lantern Control.

## Quick Start

```bash
cd sonos-local-proxy
SONOS_IP=192.168.1.175 node index.js
```

Or with argument:
```bash
node index.js 192.168.1.175
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `SONOS_IP` | `192.168.1.175` | Sonos speaker IP |
| `PORT` | `3457` | HTTP proxy port |

## API

### `GET /status`
Returns current playback state:
```json
{
  "ok": true,
  "source": "local-upnp",
  "playbackState": "PLAYBACK_STATE_PLAYING",
  "positionMillis": 42350,
  "durationMillis": 210000,
  "trackName": "Song Name",
  "artistName": "Artist"
}
```

### `GET /health`
Health check — returns `{ ok: true, sonosIp: "..." }`

## Running as a Service

### Linux (systemd)
```bash
cat > /etc/systemd/system/sonos-proxy.service << EOF
[Unit]
Description=Sonos Local Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node $(pwd)/index.js
Environment=SONOS_IP=192.168.1.175
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now sonos-proxy
```

### macOS (launchd)
```bash
node index.js 192.168.1.175 &
```

Zero dependencies — just Node.js.
