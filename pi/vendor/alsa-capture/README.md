# alsa-capture (vendored fork)

Forked from [`alsa-capture@0.3.0`](https://www.npmjs.com/package/alsa-capture) (MIT, © 2020-2022 Bernd Kaiser, feinarbyte GmbH).

## Why vendored?

Upstream `alsa-capture@0.3.0` is unmaintained (last release 2022) and depends on `nan@^2.17.0`, which fails to compile against V8 in Node 24+. The error appears in `streaming-worker.h` as `could not convert v8::Undefined(...) from Local<v8::Primitive> to Local<v8::Value>`.

This fork bumps the `nan` dependency to `^2.26.2` (2026-03), which restored Node 24 compatibility. **No source-code changes** — just a dependency bump.

## Build

Built by `pi/setup-lotus.sh` on the Pi using global `node-gyp@10` (required for Python 3.12+).

```bash
cd pi/vendor/alsa-capture
npm install --ignore-scripts        # install nan + eventemitter3
node-gyp rebuild --release          # build capture.node
```

Produces `build/Release/capture.node`, loaded dynamically by `pi/src/alsaMic.ts`.

See full upstream documentation at <https://github.com/meldron/node-alsa-capture>.

## License

MIT — see `LICENSE`.
