# RAW FINDINGS — Agent 6: configServer.ts / storage.ts / sonosPoller.ts

## HIGH robustness — Non-atomic writeFileSync → SD corruption on power loss; corrupt JSON bricks a setting
- storage.ts:94-98 setItem bare writeFileSync (truncate-then-write, no tmp+rename). Blast: configServer.ts:746,753,800,1515
- Party lamp yanked off power mid-write → half-written/zero-byte *.json. Several GET/PUT JSON.parse with NO guard: /api/calibration GET (746), PUT (753), /api/autotune/apply (800), light-calibration unguarded. Corrupt file → endpoint 500 PERMANENTLY until SSH delete.
- Fix: setItem write filePath+'.tmp' then renameSync (atomic same fs); wrap raw JSON.parse in try/catch → default + removeItem corrupt file.
- Confidence high.

## HIGH robustness/smarter — Mic gain in THREE overlapping keys → auto calibration LOST on restart
- configServer.ts:53-59,1328-1339,1395-1402; alsaMic.ts:27,33-44,595,608-618,646-655; index.ts:208-223
- micGainBase → written to mic-state.json (saveMicState incl auto-cal alsaMic.ts:595) AND mic-gain.json (PUT /api/mic-gain configServer.ts:1334). calPoint1/2 → mic-state.json AND gain-cal-points.json (1377).
- Boot order (index.ts): restoreMicState loads micGainBase from mic-state.json (fresh) → THEN index.ts:210-213 setMicGain(getItem('mic-gain')) OVERWRITES with stale mic-gain.json. So POST /api/mic-gain-calibration/start (updates only mic-state.json) is silently clobbered by old slider value on next restart. THE "restart loads wrong value" bug.
- gain-cal-points.json also fully redundant w/ mic-state.json cal points, loaded TWICE at boot (index.ts:218-222 + configServer.ts:54-58), each setGainCalPoints re-writes mic-state.json. 2 SD reads + redundant SD write per boot.
- Fix: mic-state.json = single source of truth for micGainBase + cal points. PUT /api/mic-gain & /api/gain-calibration stop writing own keys (call mic setters which persist). Delete redundant getItem('gain-cal-points') loads (index.ts:218, configServer.ts:54). Drop mic-gain.json reload (index.ts:210-213).
- Confidence high on mechanism; verify no other reader (grep shows only these).

## MED perf — Synchronous fs in request handlers shares loop with real-time audio→BLE tick
- storage.ts:88,97 readFileSync/writeFileSync from many handlers (configServer.ts:753-754,1334,1377,1385,1415,1432,1532). SD stall during wear-leveling (tens of ms) inside a save blocks the tick → dropped hops/delayed BLE.
- Fix: fs.promises.writeFile (async, still atomic via tmp+rename), or accept (writes rare). Avoid eager getItem('mic-gain') on every GET /api/mic-gain (1324 sync read even when value discarded).

## MED perf — /api/status heavy "everything" payload on hot polling path
- configServer.ts:431-576 bundles live strip + restarts last-20 (559), subsystemTransitions last-30 (566), full subsystems (571), analyser, beat, runtime, BLE. ~6 await import + big JSON.stringify. Rarely-changing history ships every poll → WiFi airtime vs BLE.
- Fix: lean hot endpoint (live strip + ble.connected + lampPct + inputLevel) for frequent poll; move history/transitions to on-demand/low-freq. /api/health already light.

## MED simplify — Two overlapping BLE tickMs-sweep benchmarks (~230 lines) + duplicated HCI introspection
- /api/ble/bench 895-1052 (~157 lines) and /api/ble/autotune 1094-1163 (~70 lines) both ramp tickMs high→low; different measurement. readConnInterval (930-946) duplicates /api/ble/conn-params (1059-1090).
- Fix: keep one sweep (bleStats-delta ble/autotune, simpler, persists tick-ms); delete/thin bench. Factor HCI conn/drain into one helper.

## MED smarter — sonosPoller no backoff during sustained gateway outage
- sonosPoller.ts:282-295 poll loop, 301-329 SSE, no retry cap. 2s poll keeps firing (4s timeout each) + eventsource auto-reconnects, indefinitely, failures swallowed (290). Radio time on doomed fetches vs BLE.
- Fix: track consecutive failures, grow interval 2s→cap 30s, reset on success. PRESERVE 30s stale-watchdog (347-356, intentional FIX 15D).

## LOW-MED robustness — Missing NaN/range validation reaches engine + SD
- /api/color 823-833 accepts {r:NaN}/neg/>255 → engine.setColor; /api/idle-color 841-850 checks only length===3 then persists to SD; gain-calibration valid() 1372-1375 accepts vol:NaN → interpolateGain division.
- Fix: clamp/Number.isFinite r/g/b 0-255, idle-color elems, vol finite (mirror /api/autotune/apply 794-795).

## LOW simplify — Dead/write-only knobs & imports
- configServer.ts:883 writes ble-min-write-interval-ms NEVER read (write-only SD wear). getSonosLastPollAt imported (19) unused. /api/auto-gain PUT (1354-1358) explicit no-op. BORTTAGET blocks 39-42,1439,1442-1443,1538-1541.

## LOW perf/correctness — /api/mic/level per-second counters shared module-closure state → concurrent pollers corrupt
- configServer.ts:1185-1199 _last* mutated in handler 1218-1257; two tabs interleave read-and-reset → garbage rates + reset each other's writeLatMaxMs (1241). Diagnostics only.

## LOW robustness/safety — Unauthenticated destructive endpoints behind open CORS *
- CORS * (130-136); /api/update/run 1579-1597, /api/update/force 1603-1628 (bash update-services.sh, sudo rm VERSION.json), /api/ble/power, /api/lifecycle/override. Any LAN device / CSRF can restart/re-image. Gate behind token or loopback/PCC-only. May be intentional (home LAN).

## LOW simplify — GET /api/sonos-gateway has write side-effect; inconsistent defaults
- 1510-1525 re-normalizes + setItem on mismatch inside GET. Defaults disagree: normalize :3053 (1453), startSonosPoller :3000 (sonosPoller.ts:256), detect probes 3050-3053 (1473). '172.0.0.1:3003' (1455) looks like 127. typo. Move normalization to PUT/boot; centralize default; fix 172.0.0.1.

**Positives:** storage keys all small fixed-size blobs (no append-growth). pollInFlight guard (sonosPoller.ts:285), SSE-pauses-poll (307-313), 30s stale→synthetic-PAUSED watchdog (347-356) sound & radio-aware. Profiles removed (39-42) so old per-profile gainCalibration mirror gone — remaining dual-store is mic-state vs mic-gain/gain-cal-points (#2).
