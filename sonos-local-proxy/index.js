#!/usr/bin/env node
/**
 * Sonos Local UPnP Proxy
 * 
 * Queries a Sonos speaker's UPnP endpoint for real-time playback position.
 * Serves it via HTTP with CORS for the Lotus Lantern Control app.
 * 
 * Usage:
 *   SONOS_IP=192.168.1.175 node index.js
 *   # or
 *   node index.js 192.168.1.175
 * 
 * The proxy listens on port 3457 by default (configurable via PORT env).
 */

const http = require('http');

const SONOS_IP = process.argv[2] || process.env.SONOS_IP || '192.168.1.175';
const SONOS_PORT = 1400;
const PORT = parseInt(process.env.PORT || '3457');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// UPnP SOAP request bodies
const POSITION_SOAP = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetPositionInfo>
  </s:Body>
</s:Envelope>`;

const TRANSPORT_SOAP = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetTransportInfo>
  </s:Body>
</s:Envelope>`;

const MEDIA_SOAP = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetMediaInfo>
  </s:Body>
</s:Envelope>`;

const VOLUME_SOAP = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
    </u:GetVolume>
  </s:Body>
</s:Envelope>`;

function soapRequest(body, action, controlPath = '/MediaRenderer/AVTransport/Control', serviceType = 'AVTransport') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: SONOS_IP,
      port: SONOS_PORT,
      path: controlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"urn:schemas-upnp-org:service:${serviceType}:1#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

function parseTime(timeStr) {
  if (!timeStr || timeStr === 'NOT_IMPLEMENTED') return null;
  const parts = timeStr.split(':');
  if (parts.length !== 3) return null;
  return (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractDidl(xml) {
  // Extract metadata from DIDL-Lite embedded in SOAP response
  const metaMatch = xml.match(/&lt;DIDL-Lite[^]*?&lt;\/DIDL-Lite&gt;/);
  if (!metaMatch) return {};
  
  // Decode XML entities
  const didl = metaMatch[0]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  
  return {
    title: extractTag(didl, 'dc:title'),
    artist: extractTag(didl, 'dc:creator'),
    album: extractTag(didl, 'upnp:album'),
    albumArtUri: extractTag(didl, 'upnp:albumArtURI'),
  };
}

async function getPlaybackStatus() {
  // Parallel requests for position, transport state, and media info
  const [posXml, transXml] = await Promise.all([
    soapRequest(POSITION_SOAP, 'GetPositionInfo'),
    soapRequest(TRANSPORT_SOAP, 'GetTransportInfo'),
  ]);

  const positionMs = parseTime(extractTag(posXml, 'RelTime'));
  const durationMs = parseTime(extractTag(posXml, 'TrackDuration'));
  const transportState = extractTag(transXml, 'CurrentTransportState');
  
  // Extract track metadata from position response
  const meta = extractDidl(posXml);

  // Map Sonos transport states to our format
  let playbackState = 'PLAYBACK_STATE_IDLE';
  if (transportState === 'PLAYING') playbackState = 'PLAYBACK_STATE_PLAYING';
  else if (transportState === 'PAUSED_PLAYBACK') playbackState = 'PLAYBACK_STATE_PAUSED';
  else if (transportState === 'TRANSITIONING') playbackState = 'PLAYBACK_STATE_PLAYING';

  // Include albumArtUri for proxying
  const albumArtUri = meta.albumArtUri || null;

  return {
    ok: true,
    source: 'local-upnp',
    playbackState,
    positionMillis: positionMs !== null ? Math.round(positionMs) : 0,
    durationMillis: durationMs !== null ? Math.round(durationMs) : null,
    trackName: meta.title || null,
    artistName: meta.artist || null,
    albumName: meta.album || null,
    albumArtUri,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === '/status' || req.url === '/') {
    try {
      const status = await getPlaybackStatus();
      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(502, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Album art proxy — pipes image from Sonos speaker with CORS headers
  if (req.url.startsWith('/art')) {
    const urlParam = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('url');
    if (!urlParam) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'missing url param' }));
      return;
    }
    try {
      // Resolve relative URIs against Sonos speaker
      const artUrl = urlParam.startsWith('http') ? urlParam : `http://${SONOS_IP}:${SONOS_PORT}${urlParam}`;
      const parsed = new URL(artUrl);
      const artReq = http.request({
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 3000,
      }, (artRes) => {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': artRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=3600',
        });
        artRes.pipe(res);
      });
      artReq.on('error', (e) => {
        res.writeHead(502, CORS_HEADERS);
        res.end(JSON.stringify({ error: e.message }));
      });
      artReq.on('timeout', () => { artReq.destroy(); });
      artReq.end();
    } catch (e) {
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, sonosIp: SONOS_IP }));
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔊 Sonos Local Proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`   Sonos IP: ${SONOS_IP}:${SONOS_PORT}`);
  console.log(`   Endpoints: GET /status, GET /health`);
});
