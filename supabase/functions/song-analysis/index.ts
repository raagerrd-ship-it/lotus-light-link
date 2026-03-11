import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const { track, artist } = await req.json();
    if (!track) {
      return new Response(JSON.stringify({ error: "Missing track" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check cache first
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const { data: cached } = await sb
      .from("song_analysis")
      .select("bpm, sections, drops, key")
      .eq("track_name", track)
      .eq("artist_name", artist || "")
      .maybeSingle();

    if (cached) {
      return new Response(
        JSON.stringify({ ...cached, track, artist, fromCache: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // AI lookup
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const prompt = `Analyze the song "${track}" by "${artist || "unknown"}".

Return ONLY a JSON object with this exact structure:
{
  "bpm": <number>,
  "key": "<musical key like Cm, F#m, G>",
  "sections": [
    {"type": "<intro|verse|pre-chorus|chorus|bridge|drop|breakdown|outro>", "startSec": <number>, "endSec": <number>, "energy": <0.0-1.0>}
  ],
  "drops": [<seconds where major energy drops/hits occur>]
}

Rules:
- sections must cover the entire song with no gaps
- energy is 0.0 (silent) to 1.0 (maximum intensity)
- drops are timestamps where the beat drops hard (chorus entries, EDM drops, etc.)
- Be as accurate as possible with section timestamps
- If you don't know the song well, estimate based on typical structure for the genre
No other text, only the JSON.`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content:
                "You are a professional music analyst. You have deep knowledge of song structures, BPM, and musical keys for popular songs across all genres. Reply only with the requested JSON.",
            },
            { role: "user", content: prompt },
          ],
        }),
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limited, try again later" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Payment required" }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI lookup failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || "";

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ bpm: null, sections: [], drops: [], key: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const analysisResult = {
      bpm: typeof parsed.bpm === "number" ? parsed.bpm : null,
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      drops: Array.isArray(parsed.drops) ? parsed.drops : [],
      key: typeof parsed.key === "string" ? parsed.key : null,
    };

    // Cache in DB (fire and forget)
    sb.from("song_analysis")
      .upsert({
        track_name: track,
        artist_name: artist || "",
        ...analysisResult,
      }, { onConflict: "track_name,artist_name" })
      .then(({ error }) => {
        if (error) console.error("Cache write error:", error);
      });

    return new Response(
      JSON.stringify({ ...analysisResult, track, artist }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("song-analysis error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
