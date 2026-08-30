// Ultra-low-latency N-API ALSA PCM capture addon for lotus-light.
// Optimized for minimum sound→FFT latency, NOT audio fidelity.
//
// Faktisk config (Lotus): stereo S32_LE @ 48 kHz, period 256 frames,
// buffer = 16× period (I2S-DMA-stabilitet på Pi Zero 2W).
// Capture thread runs SCHED_FIFO priority 80 to avoid scheduler jitter.
//
// JS API (drop-in compatible with upstream alsa-capture):
//   const cap = new Capture.StreamingWorker(onMessage, onClose, onError, opts);
//   cap.closeInput();
//
// onMessage(eventName: string, data: string, binary?: Buffer)
// Events emitted: 'audio' (binary), 'overrun', 'readError'.
// (Diagnostic events shortRead/rateDeviating/periodSizeDeviating/periodTime
//  removed — pure overhead on the hot path.)

#define ALSA_PCM_NEW_HW_PARAMS_API
#include <alsa/asoundlib.h>

#include <napi.h>
#include <pthread.h>
#include <sched.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <string>
#include <vector>
#include <memory>

namespace {

struct CaptureOptions {
  int channels = 2;
  std::string device = "default";
  snd_pcm_format_t format = SND_PCM_FORMAT_S32_LE;
  int periodSize = 256;      // ~5.3ms @ 48kHz — matchar alsaMic.ts
  int rate = 48000;
};

// Audio frame passed thread → JS. Owns its bytes.
struct AudioFrame {
  std::vector<char> bytes;
};

// Generic string-event message (overrun, readError).
struct EventMessage {
  std::string name;
  std::string data;
};

class CaptureWorker : public Napi::ObjectWrap<CaptureWorker> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "StreamingWorker", {
      InstanceMethod("closeInput", &CaptureWorker::CloseInput),
    });
    exports.Set("StreamingWorker", func);
    return exports;
  }

  CaptureWorker(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<CaptureWorker>(info), closed_(false) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsFunction() || !info[1].IsFunction() || !info[2].IsFunction()) {
      Napi::TypeError::New(env, "Expected (onMessage, onComplete, onError, [opts])")
          .ThrowAsJavaScriptException();
      return;
    }

    if (info.Length() >= 4 && info[3].IsObject()) {
      ParseOptions(info[3].As<Napi::Object>());
    }

    // Audio TSFN — high-frequency, binary frames.
    // maxQueueSize=4: obegränsad kö (0) låter en JS-stall bygga upp
    // ljudframes i heapen tills Pi:n OOM:ar. Med tak droppas gamla frames
    // (NonBlockingCall returnerar napi_queue_full) — motorn tar hellre ett
    // hål i ljudet än en växande heap.
    audioTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "alsa-audio", 4, 1);
    // Event TSFN — rare string events; same JS callback.
    eventTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "alsa-event", 8, 1);

    thread_ = std::thread(&CaptureWorker::Run, this);
  }

  ~CaptureWorker() {
    closed_ = true;
    JoinBounded();
  }

  // Bounded join: capture-tråden kan sitta fast i snd_pcm_readi om ALSA-
  // enheten hängt. Ett obegränsat join() låser då hela processen vid
  // stängning/omstart. Vänta max ~500 ms, detacha sen.
  void JoinBounded() {
    if (!thread_.joinable()) return;
    for (int i = 0; i < 50; i++) {
      if (threadDone_.load()) { thread_.join(); return; }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    thread_.detach();
  }

 private:
  void ParseOptions(const Napi::Object& opts) {
    if (opts.Has("channels"))    options_.channels    = opts.Get("channels").ToNumber().Int32Value();
    if (opts.Has("rate"))        options_.rate        = opts.Get("rate").ToNumber().Int32Value();
    if (opts.Has("periodSize"))  options_.periodSize  = opts.Get("periodSize").ToNumber().Int32Value();
    if (opts.Has("device"))      options_.device      = opts.Get("device").ToString().Utf8Value();
    if (opts.Has("format")) {
      std::string fmt = opts.Get("format").ToString().Utf8Value();
      for (int fn = 0; fn < SND_PCM_FORMAT_LAST; fn++) {
        auto e = static_cast<snd_pcm_format_t>(fn);
        const char* n = snd_pcm_format_name(e);
        if (n && fmt == n) { options_.format = e; break; }
      }
    }
  }

  Napi::Value CloseInput(const Napi::CallbackInfo& /*info*/) {
    closed_ = true;
    JoinBounded();
    return Env().Undefined();
  }

  // Hot path: emit audio frame.
  void EmitAudio(std::vector<char>&& bytes) {
    auto frame = new AudioFrame{ std::move(bytes) };
    auto status = audioTsfn_.NonBlockingCall(frame, [](Napi::Env env, Napi::Function jsCb, AudioFrame* f) {
      Napi::HandleScope scope(env);
      // Zero-copy: Buffer::New pekar rakt in i AudioFrame-vektorn; finalizern
      // äger framen. Ingen extra vektor-move/alloc per frame.
      auto buf = Napi::Buffer<char>::New(
          env, f->bytes.data(), f->bytes.size(),
          [](Napi::Env, char*, AudioFrame* owned) { delete owned; }, f);
      jsCb.Call({ Napi::String::New(env, "audio"),
                  Napi::String::New(env, ""),
                  buf });
    });
    if (status != napi_ok) delete frame;
  }

  // Cold path: rare diagnostic events.
  void EmitEvent(const char* name, const std::string& data = "") {
    auto msg = new EventMessage{ name, data };
    auto status = eventTsfn_.NonBlockingCall(msg, [](Napi::Env env, Napi::Function jsCb, EventMessage* m) {
      std::unique_ptr<EventMessage> owned(m);
      Napi::HandleScope scope(env);
      jsCb.Call({ Napi::String::New(env, owned->name),
                  Napi::String::New(env, owned->data) });
    });
    if (status != napi_ok) delete msg;
  }

  // Try to elevate this thread to SCHED_FIFO. Best-effort; ignore if denied.
  static void TryRealtimePriority() {
    struct sched_param sp{};
    sp.sched_priority = 80;
    pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
  }

  void Run() {
    RunInner();
    threadDone_.store(true);
  }

  void RunInner() {
    TryRealtimePriority();

    snd_pcm_t* handle = nullptr;
    int rc = snd_pcm_open(&handle, options_.device.c_str(), SND_PCM_STREAM_CAPTURE, 0);
    if (rc < 0) {
      char buf[256];
      snprintf(buf, sizeof(buf), "snd_pcm_open(device='%s') failed: rc=%d errno=%d (%s) — %s",
               options_.device.c_str(), rc, -rc, strerror(-rc), snd_strerror(rc));
      EmitEvent("readError", buf);
      return;
    }

    snd_pcm_hw_params_t* params = nullptr;
    snd_pcm_hw_params_alloca(&params);
    snd_pcm_hw_params_any(handle, params);
    snd_pcm_hw_params_set_access(handle, params, SND_PCM_ACCESS_RW_INTERLEAVED);
    snd_pcm_hw_params_set_format(handle, params, options_.format);
    snd_pcm_hw_params_set_channels(handle, params, static_cast<unsigned int>(options_.channels));

    unsigned int val = static_cast<unsigned int>(options_.rate);
    int dir = 0;
    snd_pcm_hw_params_set_rate_near(handle, params, &val, &dir);

    snd_pcm_uframes_t frames = static_cast<snd_pcm_uframes_t>(options_.periodSize);
    snd_pcm_hw_params_set_period_size_near(handle, params, &frames, &dir);

    // Buffer = 16× period. 8× (2048 @ period=256) wedgar I2S-DMA:n — reproducerat
    // med ren arecord: period 256 + buffer 2048 → WEDGAR, 4096 → STABIL.
    // Latens påverkas INTE — ALSA-tråden läser så fort den kan, bufferten är bara
    // säkerhetsmarginal mot eventloop-jitter på den lilla CPU:n.
    snd_pcm_uframes_t bufFrames = frames * 16;
    snd_pcm_hw_params_set_buffer_size_near(handle, params, &bufFrames);

    // BÅDE buffer_size och periods måste sättas explicit — ingen räcker ensam på
    // Pi Zero 2W I2S-DMA. 16 perioder ger samma totala buffertstorlek som ovan.
    {
      unsigned int nper = 16; int pdir = 0;
      snd_pcm_hw_params_set_periods_near(handle, params, &nper, &pdir);
    }


    rc = snd_pcm_hw_params(handle, params);
    if (rc < 0) {
      EmitEvent("readError", std::string("Unable to set HW params: ") + snd_strerror(rc));
      snd_pcm_close(handle);
      return;
    }

    // Satt SW-PARAMS EXPLICIT. capture.cc gjorde det ALDRIG, arecord gor det alltid.
    // Utan dem far strommen ALSA:s defaults -> annan start-semantik -> I2S-DMA-wedge
    // (mikrofonen levererar samma sampel om och om igen, "tyst mic-frys").
    {
      snd_pcm_sw_params_t *sw;
      snd_pcm_sw_params_alloca(&sw);
      if (snd_pcm_sw_params_current(handle, sw) >= 0) {
        snd_pcm_sw_params_set_start_threshold(handle, sw, 1);
        snd_pcm_sw_params_set_avail_min(handle, sw, frames);
        snd_pcm_sw_params_set_stop_threshold(handle, sw, bufFrames);
        int swrc = snd_pcm_sw_params(handle, sw);
        if (swrc < 0) EmitEvent("readError", std::string("sw_params: ") + snd_strerror(swrc));
      }
    }


    snd_pcm_uframes_t actualFrames = 0;
    snd_pcm_hw_params_get_period_size(params, &actualFrames, &dir);

    int physWidth = snd_pcm_format_physical_width(options_.format);
    if (physWidth <= 0) physWidth = 16;
    size_t bytesPerFrame = (static_cast<size_t>(options_.channels) * static_cast<size_t>(physWidth)) / 8;
    size_t bufferBytes   = static_cast<size_t>(actualFrames) * bytesPerFrame;

    // snd_pcm_wait pollar annars en PREPARED (ej RUNNING) capture-ström → aldrig
    // data → INGET LJUD. Original-koden auto-startade via första snd_pcm_readi;
    // med wait-först måste strömmen startas explicit här.
    { int sr = snd_pcm_start(handle); if (sr < 0) snd_pcm_prepare(handle); }


    while (!closed_.load(std::memory_order_acquire)) {
      // Efter recover/prepare står strömmen i PREPARED — snd_pcm_wait pollar då
      // en icke-RUNNING ström och returnerar aldrig data (tyst mic-frys utan
      // fel). Starta om strömmen explicit innan varje wait om den inte kör.
      snd_pcm_state_t st = snd_pcm_state(handle);
      if (st == SND_PCM_STATE_PREPARED || st == SND_PCM_STATE_SETUP) {
        if (st == SND_PCM_STATE_SETUP) snd_pcm_prepare(handle);
        if (snd_pcm_start(handle) < 0) { snd_pcm_prepare(handle); snd_pcm_start(handle); }
      } else if (st == SND_PCM_STATE_XRUN || st == SND_PCM_STATE_SUSPENDED ||
                 st == SND_PCM_STATE_DISCONNECTED) {
        if (snd_pcm_recover(handle, -EPIPE, 1) < 0) {
          EmitEvent("readError", "stream unrecoverable state");
          break;
        }
        snd_pcm_start(handle);
      }
      // Vänta max 100ms på data. Utan detta blockerar snd_pcm_readi tills en hel
      // period kommit → closed_ kan ej kollas → JoinBounded detachar en fastnad
      // tråd → snd_pcm_drop/close körs ALDRIG → I2S-strömmen halvt nedriven →
      // nästa open wedgar DMA:n (tyst mic-frys, kräver reboot). Med wait exitar
      // tråden rent inom ~100ms → ren teardown, ingen detach.

      int wr = snd_pcm_wait(handle, 100);
      if (wr == 0) continue;  // timeout → kolla closed_ igen
      if (wr < 0) {           // -EPIPE (overrun) m.fl.
        if (snd_pcm_recover(handle, wr, 1) < 0) {
          EmitEvent("readError", snd_strerror(wr));
          break;
        }
        continue;
      }
      // Läs direkt i den vektor som skickas vidare — ingen memcpy per callback.
      std::vector<char> frameBuf(bufferBytes);
      snd_pcm_sframes_t got = snd_pcm_readi(handle, frameBuf.data(), actualFrames);
      if (got == -EPIPE) {
        EmitEvent("overrun", "overrun");
        snd_pcm_prepare(handle);
        continue;
      }
      if (got < 0) {
        if (snd_pcm_recover(handle, static_cast<int>(got), 1) < 0) {
          EmitEvent("readError", snd_strerror(static_cast<int>(got)));
          break;
        }
        continue;
      }
      // Defensive clamp: a misbehaving driver returning more frames than
      // requested would overflow readBuf and corrupt the heap (observed:
      // SIGABRT "malloc(): invalid size (unsorted)" on Pi Zero 2W).
      if (static_cast<snd_pcm_uframes_t>(got) > actualFrames) {
        got = static_cast<snd_pcm_sframes_t>(actualFrames);
      }
      const size_t copyBytes = static_cast<size_t>(got) * bytesPerFrame;
      if (copyBytes == 0 || copyBytes > frameBuf.size()) continue;
      frameBuf.resize(copyBytes);  // krymper bara → ingen realloc
      EmitAudio(std::move(frameBuf));
    }

    if (audioTsfn_) audioTsfn_.Release();
    if (eventTsfn_) eventTsfn_.Release();
    snd_pcm_drop(handle);
    snd_pcm_close(handle);
  }

  CaptureOptions options_;
  std::atomic<bool> closed_;
  std::thread thread_;
  std::atomic<bool> threadDone_{false};
  Napi::ThreadSafeFunction audioTsfn_;
  Napi::ThreadSafeFunction eventTsfn_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return CaptureWorker::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(capture, InitAll)
