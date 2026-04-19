# alsa-capture (lotus-light N-API rewrite)

Originally forked from [`alsa-capture@0.3.0`](https://www.npmjs.com/package/alsa-capture)
(MIT, © 2020-2022 Bernd Kaiser, feinarbyte GmbH). The original NAN-based addon
stopped compiling on Node 24 (V8 14) due to three independent NAN/V8 ABI breaks
that even `nan@2.26.2` could not paper over. Rather than chase third-party header
incompatibilities, this addon was rewritten on top of **`node-addon-api`** (N-API,
ABI-stable across Node 18+).

## JS API (unchanged)

```js
const Capture = require('./build/Release/capture');
const cap = new Capture.StreamingWorker(
  (eventName, dataString, binaryBuffer) => { /* ... */ },
  () => { /* close */ },
  (err) => { /* error */ },
  { channels: 1, rate: 44100, format: 'S16_LE', device: 'plughw:0,0', periodSize: 128 }
);
cap.closeInput();
```

The `index.js` wrapper turns this into an EventEmitter (`'audio'`, `'overrun'`,
`'shortRead'`, `'readError'`, `'rateDeviating'`, `'periodSizeDeviating'`,
`'periodTime'`, `'close'`, `'error'`) for drop-in compat with upstream.

## Build

Built by `pi/setup-lotus.sh` on the Pi (or by GitHub Actions during release):

```bash
cd pi/vendor/alsa-capture
npm install --ignore-scripts        # installs node-addon-api + eventemitter3
node-gyp rebuild --release          # builds build/Release/capture.node
```

Produces `build/Release/capture.node`, loaded dynamically by `pi/src/alsaMic.ts`.

## License

MIT — see `LICENSE`.
