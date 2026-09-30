// FALSK SONOS-GATEWAY (egen process, sa dess skrap inte raknas i motorn): /api/status + /api/events (SSE) med samma
// JSON-form som sonos-gateway pa brygg-Pi:n. Laten foljer spellistan och HARNESS_T0 (samma som fakeAlsa).
import http from 'node:http';
import fs from 'node:fs';
const PL = JSON.parse(fs.readFileSync(process.env.HARNESS_PLAYLIST, 'utf8'));
const T0 = Number(process.env.HARNESS_T0);
const PORT = Number(process.env.GW_PORT || 3953);
const total = PL.reduce((a, s) => a + s.seconds, 0);
const PALS = [[[255, 151, 0], [255, 0, 0], [232, 78, 59], [255, 151, 0]], [[184, 152, 0], [184, 178, 134], [184, 152, 0], [184, 152, 0]], [[255, 0, 64], [255, 131, 0], [255, 0, 0], [255, 0, 64]], [[79, 139, 166], [235, 160, 93], [198, 139, 96], [79, 139, 166]]];
function now() {
  let t = (((Date.now() - T0) / 1000) % total + total) % total;
  for (let i = 0; i < PL.length; i++) { if (t < PL[i].seconds) return { i, pos: Math.floor(t * 1000) }; t -= PL[i].seconds; }
  return { i: 0, pos: 0 };
}
function full(source) {
  const { i, pos } = now(); const s = PL[i], n = PL[(i + 1) % PL.length];
  return {
    ok: true, source, playbackState: 'PLAYBACK_STATE_PLAYING', positionMillis: pos, durationMillis: s.seconds * 1000,
    trackName: s.title, artistName: s.artist, albumName: 'Album', albumArtUri: `http://192.168.1.158:1400/getaa?s=1&u=fake${i}`,
    nextTrackName: n.title, nextArtistName: n.artist, nextAlbumArtUri: `http://192.168.1.158:1400/getaa?s=1&u=fake${(i + 1) % PL.length}`,
    volume: 12, mute: false, bass: 3, treble: 5, loudness: true, mediaType: 'track', trackNumber: i + 1,
    currentURI: 'x-rincon-queue:RINCON_FAKE#0', currentPalette: PALS[i % PALS.length], nextPalette: PALS[(i + 1) % PALS.length],
    groupName: 'Bank', timestamp: Date.now(),
  };
}
function tick() {
  const { i, pos } = now(); const s = PL[i];
  return { ok: true, source: 'position-tick', positionMillis: pos, durationMillis: s.seconds * 1000, volume: 12, mute: false, mediaType: 'track', trackName: s.title, artistName: s.artist, playbackState: 'PLAYBACK_STATE_PLAYING', groupName: 'Bank' };
}
const clients = new Set(); let lastSong = -1;
http.createServer((req, res) => {
  if (req.url.startsWith('/api/status')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(full('local-upnp'))); return; }
  if (req.url.startsWith('/api/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(full('upnp-event'))}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`fakeGateway :${PORT}`));
setInterval(() => {
  const { i } = now(); const msg = i !== lastSong ? full('upnp-event') : tick(); lastSong = i;
  const line = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(line);
}, 1000);
