# RAW FINDINGS — Agent 3: alsaMic / input / native binding

**Headline:** The blocking ALSA read does NOT stall the loop (runs on a dedicated SCHED_FIFO std::thread → JS via ThreadSafeFunction; loop only runs onAudioData). But two adjacent mechanisms can freeze/amplify.

## HIGH robustness — Capture-thread join() at GC can freeze loop; restart reopens hw:0,0 before old closes
- capture.cc:84-87 (~CaptureWorker → thread_.join()), capture.cc:105-108 (closeInput only sets flag), alsaMic.ts:936-950 (restartCapture), 952-964 (stopMic)
- close() only sets closed_=true; thread joined in C++ destructor at GC finalize, unbounded, no timeout. restartCapture calls stopMic then SYNCHRONOUSLY startMic → opens raw hw:0,0 while old thread still in snd_pcm_readi/close → -EBUSY race. If read thread wedged in snd_pcm_readi, never rechecks closed_ → when GC'd, thread_.join() blocks event loop indefinitely. CREDIBLE ROOT CAUSE for the 8s freeze (join-at-GC on stuck read thread, not the read itself).
- Fix: defer startMic ~120ms after stopMic (let hw:0,0 release), confirm via waitForFirstAudio before success. In binding: closeInput() joins with bounded timeout, or detach() a wedged thread so GC never blocks.
- Confidence high on mechanism, medium on 8s contribution. Deferred-reopen low risk; binding change needs C++ rebuild.

## HIGH memory — Unbounded ThreadSafeFunction audio queue amplifies GC-swap freeze
- capture.cc:75-79 both TSFNs maxQueueSize=0 (unlimited); EmitAudio 111-122 new AudioFrame + NonBlockingCall per read
- On stall, capture thread keeps reading every ~5.8ms, queues fresh AudioFrame unbounded (~370KB/s; 8s stall ≈ 3MB burst-drained, each a JS Buffer). On 512MB swap-off this FEEDS the pressure that triggers the freeze; post-stall drains stale audio ("segt").
- Fix: bound audio TSFN maxQueueSize ~4-8, drop-oldest on full (want newest during stall).
- Confidence high it's unbounded, medium magnitude. Binding change + rebuild.

## MED robustness — Failed restart leaves dead mic the stall-watchdog won't retry
- alsaMic.ts:930-933 isMicStalled, 936-950 restartCapture (sets _lastAudioCbAt=0, returns true), 712-716 readError→handleStartFailure (doesn't null capture)
- startMic failure is ASYNC (bad open → later readError, not constructor throw), so try/catch never sees it. isMicStalled returns false while _lastAudioCbAt===0. If reopen never delivers (the -EBUSY race), capture stays non-null, _lastAudioCbAt stays 0, isMicStalled permanently false → 1.5s watchdog NEVER retries → mic dead until coarse process watchdog.
- Fix: after restart verify waitForFirstAudio(timeout), retry/escalate on reject; treat "capture non-null but _lastAudioCbAt===0 > N ms after restart" as stalled.

## MED robustness — Dead 'close'/'error' handlers give false disconnect coverage
- alsaMic.ts:713-719 capture.on('error'/'close'); binding validates info[1]/info[2] are functions but NEVER stores/invokes them (capture.cc:60-82). Native emits only 'audio','overrun','readError'. On fatal error read loop emits 'readError' + break (capture.cc:203-208), thread dies silently, no 'close', capture stays non-null. All recovery hinges on readError + 1.5s stall watchdog.
- Fix: wire info[1]/info[2] to emit close/error, OR delete dead JS handlers and document readError+watchdog is sole channel (and harden it per above).

## MED robustness — Cal-point gains can poison light chain with NaN
- alsaMic.ts:620-629 interpolateGain uses Math.log(g1)/Math.log(g2); from setGainCalPoints 608-618, restoreMicState 649-651 → micGain → amp=lightRawRms*micGain (378)
- If cal gain is 0/negative/non-finite, Math.log → -Inf/NaN → micGain NaN → totalRms/bassRms/midHiRms all NaN into analyser/dirigent. restoreMicState only checks typeof==='number' (NaN passes); setGainCalPoints no validation.
- Fix: clamp cal gains to positive finite at every ingress; guard interpolateGain (if(!(g1>0)||!(g2>0)) return base; final Number.isFinite check).

## LOW-MED memory — Per-frame array alloc in emitBands
- alsaMic.ts:412-415 const onsets=[o.sub,...o.air] fresh 8-elem array every emitBands (~75Hz) just to index first beatCutoffBands. Fix: sum fields directly / reuse module-level array.

## LOW perf/memory — Native double-copy + per-callback JS Buffer alloc
- capture.cc:216-219 std::vector out(...) then :116 Buffer::Copy → copies twice + new Buffer ~187x/s; onAudioData new Int32Array view per cb. Fix: Buffer::New over moved vector (finalizer frees), or ring of reusable buffers.

## LOW simplify — Dead constant BYTES_PER_SAMPLE (alsaMic.ts:475), referenced nowhere. Delete.
## LOW perf — Redundant hot-loop counters lightCntLocal/calCntLocal (813,823,843) == frameCount. Drop.
## LOW perf — prePeak computed every sample but only used under DEBUG (831-832,852,864-865). Gate behind DEBUG_ENABLED.
## LOW memory — acrBuf 160KB (Int16Array(80000)) always allocated at load (314) though ACR off by default. Lazy-alloc.
## LOW doc — Config drift vs note (257-264 target 0.75/maxGain 200 vs two-taps note 0.8/600; seedAnalyserGain clamps 300 vs analyser 200).

**Verified-correct (do not re-litigate):** two-tap split clean (ring is raw+hi-shelf no micGain :833-834; light tap applies micGain linearly+clamp :378-379; analyser reads raw ring :893 — no accidental AGC of light). Ring drain FIFO safe (max ~384 vs RING_SIZE 1024). Division guards present (totAbs+1e-9, beatCutoffBands≥1, cal count<100). Overrun/-EPIPE recovery sound (198-209), over-read clamp (213-215). Duplicated S32/S16 loops intentional (format check hoisted).
