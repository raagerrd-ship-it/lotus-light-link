import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { HmacSha1 } from "https://deno.land/std@0.168.0/hash/sha1.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const host = Deno.env.get("ACRCLOUD_HOST");
    const accessKey = Deno.env.get("ACRCLOUD_ACCESS_KEY");
    const accessSecret = Deno.env.get("ACRCLOUD_ACCESS_SECRET");

    if (!host || !accessKey || !accessSecret) {
      throw new Error("ACRCloud credentials not configured");
    }

    // Expect base64-encoded audio in the request body
    const { audio, sampleRate, channels } = await req.json();
    if (!audio) {
      throw new Error("No audio data provided");
    }

    // Decode the base64 audio back to binary
    const audioBytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));

    // Build WAV file from raw PCM
    const wavBytes = buildWav(audioBytes, sampleRate || 8000, channels || 1);

    // ACRCloud signature
    const httpMethod = "POST";
    const httpUri = "/v1/identify";
    const dataType = "audio";
    const signatureVersion = "1";
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const stringToSign = `${httpMethod}\n${httpUri}\n${accessKey}\n${dataType}\n${signatureVersion}\n${timestamp}`;
    const hmac = new HmacSha1(accessSecret);
    hmac.update(stringToSign);
    const signature = base64Encode(new Uint8Array(hmac.arrayBuffer()));

    // Build multipart form
    const formData = new FormData();
    formData.append("sample", new Blob([wavBytes], { type: "audio/wav" }), "sample.wav");
    formData.append("sample_bytes", wavBytes.length.toString());
    formData.append("access_key", accessKey);
    formData.append("data_type", dataType);
    formData.append("signature_version", signatureVersion);
    formData.append("signature", signature);
    formData.append("timestamp", timestamp);

    const acrUrl = `https://${host}/v1/identify`;
    const response = await fetch(acrUrl, {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`ACRCloud API error [${response.status}]: ${JSON.stringify(result)}`);
    }

    // Extract relevant info
    const status = result?.status;
    if (status?.code !== 0) {
      return new Response(
        JSON.stringify({ identified: false, message: status?.msg || "No match" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const music = result?.metadata?.music?.[0];
    if (!music) {
      return new Response(
        JSON.stringify({ identified: false, message: "No music metadata" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract BPM from Deezer or Spotify metadata if available
    let bpm = null;
    const deezer = music?.external_metadata?.deezer;
    if (deezer?.track?.bpm) bpm = deezer.track.bpm;
    const spotify = music?.external_metadata?.spotify;
    if (!bpm && spotify?.track?.bpm) bpm = spotify.track.bpm;

    return new Response(
      JSON.stringify({
        identified: true,
        title: music.title || "Unknown",
        artist: music.artists?.[0]?.name || "Unknown",
        album: music.album?.name || null,
        bpm: bpm,
        duration_ms: music.duration_ms || null,
        acrid: music.acrid || null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("identify-song error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/** Build a minimal WAV file from raw 16-bit PCM data */
function buildWav(pcmData: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + pcmData.length);
  const view = new DataView(wav.buffer);

  // RIFF header
  writeString(wav, 0, "RIFF");
  view.setUint32(4, 36 + pcmData.length, true);
  writeString(wav, 8, "WAVE");

  // fmt chunk
  writeString(wav, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(wav, 36, "data");
  view.setUint32(40, pcmData.length, true);
  wav.set(pcmData, 44);

  return wav;
}

function writeString(buf: Uint8Array, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}
