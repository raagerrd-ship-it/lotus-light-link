// Minimal N-API ALSA PCM capture addon for lotus-light.
// Replaces the abandoned NAN-based alsa-capture@0.3.0 which broke under Node 24.
// Uses node-addon-api (NAPI_VERSION=8) — ABI-stable across Node 18+.
//
// JS API (unchanged from upstream alsa-capture for drop-in compatibility):
//   const cap = new Capture.StreamingWorker(onMessage, onClose, onError, opts);
//   cap.closeInput();
//
// onMessage(eventName: string, data: string, binary?: Buffer)
// Events emitted: 'audio' (binary), 'overrun', 'shortRead', 'readError',
//                 'rateDeviating', 'periodSizeDeviating', 'periodTime'.

#define ALSA_PCM_NEW_HW_PARAMS_API
#include <alsa/asoundlib.h>

#include <napi.h>
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
  int periodSize = 128;
  int periodTime = 0;
  int rate = 44100;
};

// Message passed from capture thread → JS callback via TSFN.
// Owns its binary buffer (transferred to a Node Buffer in the JS callback).
struct CaptureMessage {
  std::string name;
  std::string data;
  std::vector<char> binary;
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

    completeCb_ = Napi::Persistent(info[1].As<Napi::Function>());
    errorCb_    = Napi::Persistent(info[2].As<Napi::Function>());

    // Threadsafe function for emitting messages from the capture thread.
    tsfn_ = Napi::ThreadSafeFunction::New(
        env,
        info[0].As<Napi::Function>(),
        "alsa-capture-emit",
        0,    // unlimited queue
        1);   // single producer thread

    // Spawn capture thread
    thread_ = std::thread(&CaptureWorker::Run, this);
  }

  ~CaptureWorker() {
    closed_ = true;
    if (thread_.joinable()) thread_.join();
    if (tsfn_) tsfn_.Release();
  }

 private:
  void ParseOptions(const Napi::Object& opts) {
    if (opts.Has("channels"))    options_.channels    = opts.Get("channels").ToNumber().Int32Value();
    if (opts.Has("rate"))        options_.rate        = opts.Get("rate").ToNumber().Int32Value();
    if (opts.Has("periodSize"))  options_.periodSize  = opts.Get("periodSize").ToNumber().Int32Value();
    if (opts.Has("periodTime"))  options_.periodTime  = opts.Get("periodTime").ToNumber().Int32Value();
    if (opts.Has("device"))      options_.device      = opts.Get("device").ToString().Utf8Value();
    if (opts.Has("format")) {
      std::string fmt = opts.Get("format").ToString().Utf8Value();
      // Look up format by name via ALSA's enum table
      bool found = false;
      for (int fn = 0; fn < SND_PCM_FORMAT_LAST; fn++) {
        auto e = static_cast<snd_pcm_format_t>(fn);
        const char* n = snd_pcm_format_name(e);
        if (n && fmt == n) { options_.format = e; found = true; break; }
      }
      if (!found) {
        // Default already set; leave as S16_LE.
      }
    }
  }

  Napi::Value CloseInput(const Napi::CallbackInfo& /*info*/) {
    closed_ = true;
    return Env().Undefined();
  }

  // Emit a message from the capture thread → JS callback.
  void Emit(std::unique_ptr<CaptureMessage> msg) {
    auto raw = msg.release();
    auto status = tsfn_.NonBlockingCall(raw, [](Napi::Env env, Napi::Function jsCb, CaptureMessage* m) {
      std::unique_ptr<CaptureMessage> owned(m);
      Napi::HandleScope scope(env);
      if (!owned->binary.empty()) {
        auto buf = Napi::Buffer<char>::Copy(env, owned->binary.data(), owned->binary.size());
        jsCb.Call({ Napi::String::New(env, owned->name),
                    Napi::String::New(env, owned->data),
                    buf });
      } else {
        jsCb.Call({ Napi::String::New(env, owned->name),
                    Napi::String::New(env, owned->data) });
      }
    });
    if (status != napi_ok) {
      // queue full or shutdown — drop this message; reclaim memory
      delete raw;
    }
  }

  void EmitSimple(const char* name, const std::string& data = "") {
    auto m = std::make_unique<CaptureMessage>();
    m->name = name;
    m->data = data;
    Emit(std::move(m));
  }

  void Run() {
    snd_pcm_t* handle = nullptr;
    int rc = snd_pcm_open(&handle, options_.device.c_str(), SND_PCM_STREAM_CAPTURE, 0);
    if (rc < 0) {
      EmitSimple("readError", std::string("Unable to open PCM: ") + snd_strerror(rc));
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

    if (options_.periodTime > 0) {
      auto pt = static_cast<unsigned int>(options_.periodTime);
      snd_pcm_hw_params_set_period_time_near(handle, params, &pt, &dir);
    }

    rc = snd_pcm_hw_params(handle, params);
    if (rc < 0) {
      EmitSimple("readError", std::string("Unable to set HW params: ") + snd_strerror(rc));
      snd_pcm_close(handle);
      return;
    }

    unsigned int actualRate = 0;
    snd_pcm_hw_params_get_rate(params, &actualRate, &dir);
    if (actualRate != static_cast<unsigned int>(options_.rate)) {
      EmitSimple("rateDeviating", std::to_string(actualRate));
    }

    snd_pcm_uframes_t actualFrames = 0;
    snd_pcm_hw_params_get_period_size(params, &actualFrames, &dir);
    if (actualFrames != static_cast<snd_pcm_uframes_t>(options_.periodSize)) {
      EmitSimple("periodSizeDeviating", std::to_string(actualFrames));
    }

    unsigned int actualPeriodTime = 0;
    snd_pcm_hw_params_get_period_time(params, &actualPeriodTime, &dir);
    EmitSimple("periodTime", std::to_string(actualPeriodTime));

    int physWidth = snd_pcm_format_physical_width(options_.format);
    if (physWidth <= 0) physWidth = 16;
    size_t bytesPerFrame = (static_cast<size_t>(options_.channels) * static_cast<size_t>(physWidth)) / 8;
    size_t bufferBytes   = static_cast<size_t>(actualFrames) * bytesPerFrame;

    std::vector<char> buffer(bufferBytes);

    while (!closed_.load(std::memory_order_acquire)) {
      snd_pcm_sframes_t got = snd_pcm_readi(handle, buffer.data(), actualFrames);
      if (got == -EPIPE) {
        EmitSimple("overrun", "overrun occurred");
        snd_pcm_prepare(handle);
        continue;
      }
      if (got < 0) {
        EmitSimple("readError", snd_strerror(static_cast<int>(got)));
        // Try to recover; if not, exit loop.
        if (snd_pcm_recover(handle, static_cast<int>(got), 1) < 0) break;
        continue;
      }
      if (got != static_cast<snd_pcm_sframes_t>(actualFrames)) {
        EmitSimple("shortRead", std::to_string(got));
      }

      auto m = std::make_unique<CaptureMessage>();
      m->name = "audio";
      m->binary.assign(buffer.data(), buffer.data() + (static_cast<size_t>(got) * bytesPerFrame));
      Emit(std::move(m));
    }

    snd_pcm_drain(handle);
    snd_pcm_close(handle);
  }

  CaptureOptions options_;
  std::atomic<bool> closed_;
  std::thread thread_;
  Napi::ThreadSafeFunction tsfn_;
  Napi::FunctionReference completeCb_;
  Napi::FunctionReference errorCb_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return CaptureWorker::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(capture, InitAll)