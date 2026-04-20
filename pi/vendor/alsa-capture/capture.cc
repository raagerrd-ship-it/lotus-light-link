// Ultra-low-latency N-API ALSA PCM capture addon for lotus-light.
// Optimized for minimum sound→FFT latency, NOT audio fidelity.
//
// Default config: 32-frame periods @ 44.1kHz = ~0.7ms capture buffer.
// Buffer size = 2× period (minimal ALSA queue depth).
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
#include <string>
#include <vector>
#include <memory>

namespace {

struct CaptureOptions {
  int channels = 1;
  std::string device = "default";
  snd_pcm_format_t format = SND_PCM_FORMAT_S16_LE;
  int periodSize = 32;       // ~0.7ms @ 44.1kHz — was 128 (~2.9ms)
  int rate = 44100;
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
    audioTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "alsa-audio", 0, 1);
    // Event TSFN — rare string events; same JS callback.
    eventTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "alsa-event", 0, 1);

    thread_ = std::thread(&CaptureWorker::Run, this);
  }

  ~CaptureWorker() {
    closed_ = true;
    if (thread_.joinable()) thread_.join();
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
    return Env().Undefined();
  }

  // Hot path: emit audio frame.
  void EmitAudio(std::vector<char>&& bytes) {
    auto frame = new AudioFrame{ std::move(bytes) };
    auto status = audioTsfn_.NonBlockingCall(frame, [](Napi::Env env, Napi::Function jsCb, AudioFrame* f) {
      std::unique_ptr<AudioFrame> owned(f);
      Napi::HandleScope scope(env);
      auto buf = Napi::Buffer<char>::Copy(env, owned->bytes.data(), owned->bytes.size());
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

    // Buffer = 8× period. På Pi Zero 2W är 2× för aggressivt — varje JS GC
    // eller långsam BLE-write överstiger 5.8ms och vi tappar samples →
    // [ALSA] Buffer overrun spam → engine får inga FFT-frames → 0% output.
    // 8× ger ~23ms headroom @ period=128 (~46ms @ period=256). Latens påverkas
    // INTE — ALSA-tråden läser så fort den kan, bufferten är bara säkerhetsmarginal
    // mot eventloop-jitter på den lilla CPU:n.
    snd_pcm_uframes_t bufFrames = frames * 8;
    snd_pcm_hw_params_set_buffer_size_near(handle, params, &bufFrames);

    rc = snd_pcm_hw_params(handle, params);
    if (rc < 0) {
      EmitEvent("readError", std::string("Unable to set HW params: ") + snd_strerror(rc));
      snd_pcm_close(handle);
      return;
    }

    snd_pcm_uframes_t actualFrames = 0;
    snd_pcm_hw_params_get_period_size(params, &actualFrames, &dir);

    int physWidth = snd_pcm_format_physical_width(options_.format);
    if (physWidth <= 0) physWidth = 16;
    size_t bytesPerFrame = (static_cast<size_t>(options_.channels) * static_cast<size_t>(physWidth)) / 8;
    size_t bufferBytes   = static_cast<size_t>(actualFrames) * bytesPerFrame;

    std::vector<char> readBuf(bufferBytes);

    while (!closed_.load(std::memory_order_acquire)) {
      snd_pcm_sframes_t got = snd_pcm_readi(handle, readBuf.data(), actualFrames);
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
      if (copyBytes == 0 || copyBytes > readBuf.size()) continue;
      std::vector<char> out(readBuf.data(), readBuf.data() + copyBytes);
      EmitAudio(std::move(out));
    }

    if (audioTsfn_) audioTsfn_.Release();
    if (eventTsfn_) eventTsfn_.Release();
    snd_pcm_drop(handle);
    snd_pcm_close(handle);
  }

  CaptureOptions options_;
  std::atomic<bool> closed_;
  std::thread thread_;
  Napi::ThreadSafeFunction audioTsfn_;
  Napi::ThreadSafeFunction eventTsfn_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return CaptureWorker::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(capture, InitAll)
