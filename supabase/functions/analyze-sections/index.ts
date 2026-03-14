import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EnergySample {
  t: number;
  e?: number;
  rawRms?: number;
  kick?: boolean;
  lo?: number;
  mid?: number;
  hi?: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { songId } = await req.json();
    if (!songId) throw new Error("Missing songId");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: song, error: fetchErr } = await supabase
      .from("song_analysis")
      .select("energy_curve, track_name, artist_name, sections")
      .eq("id", songId)
      .single();

    if (fetchErr || !song) throw new Error("Song not found");
    if (song.sections && (song.sections as any[]).length > 0) {
      return new Response(JSON.stringify({ sections: song.sections, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const curve = song.energy_curve as EnergySample[];
    if (!Array.isArray(curve) || curve.length < 20) throw new Error("Insufficient energy data");

    // Compute peak for normalization (rawRms-based)
    const peakRms = Math.max(...curve.map(s => s.rawRms ?? s.e ?? 0), 0.001);

    // Downsample curve for AI prompt (max ~200 points)
    const step = Math.max(1, Math.floor(curve.length / 200));
    const sampled = curve.filter((_, i) => i % step === 0);
    const csvLines = sampled.map(s => {
      const energy = (s.rawRms ?? s.e ?? 0) / peakRms;
      return `${s.t.toFixed(1)},${energy.toFixed(3)},${(s.lo ?? 0).toFixed(2)},${(s.mid ?? 0).toFixed(2)},${(s.hi ?? 0).toFixed(2)},${s.kick ? 1 : 0}`;
    });

    const prompt = `Analyze this song's energy curve and classify each time range into song sections.
Song: "${song.track_name}" by ${song.artist_name}

Data format: time(s),energy(0-1 normalized),low_freq,mid_freq,high_freq,kick(0/1)
${csvLines.join("\n")}

Rules for classification:
- Use the FULL set of section types. Most pop/rock songs have: intro, verse, pre_chorus, chorus, bridge, outro. Many also have build_up, drop, or break.
- A "bridge" typically appears once late in the song (often after second chorus) with distinctly different energy/frequency profile from verses and choruses.
- "chorus" sections are HIGH energy, repeating with similar patterns. Don't label everything high-energy as chorus.
- "pre_chorus" is a transitional buildup before the chorus — rising energy, often shorter.
- "build_up" is a sustained energy ramp (common in EDM) leading to a "drop".
- "break" is a sudden energy reduction mid-song.
- Look at frequency balance changes: bridges often shift mid/hi balance vs verses.
- Assign intensity 0.0-1.0 reflecting actual energy level of each section.

Return sections covering the entire song duration with no gaps.`;


    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: "You are a music analysis expert. Analyze energy curves and classify song sections. Return ONLY the tool call, no other text.",
          },
          { role: "user", content: prompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "classify_sections",
              description: "Return the classified sections of the song",
              parameters: {
                type: "object",
                properties: {
                  sections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        start: { type: "number", description: "Start time in seconds" },
                        end: { type: "number", description: "End time in seconds" },
                        type: {
                          type: "string",
                          enum: ["intro", "verse", "pre_chorus", "chorus", "bridge", "drop", "build_up", "break", "outro"],
                        },
                        intensity: { type: "number", description: "0.0-1.0 intensity level" },
                      },
                      required: ["start", "end", "type", "intensity"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["sections"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "classify_sections" } },
      }),
    });

    if (!aiResponse.ok) {
      const status = aiResponse.status;
      const text = await aiResponse.text();
      console.error("AI gateway error:", status, text);
      if (status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, try again later" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI error: ${status}`);
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("No tool call in AI response");

    const parsed = JSON.parse(toolCall.function.arguments);
    const sections = parsed.sections;

    // Save to DB
    await supabase
      .from("song_analysis")
      .update({ sections: sections as any })
      .eq("id", songId);

    console.log(`[analyze-sections] ${song.track_name}: ${sections.length} sections`);

    return new Response(JSON.stringify({ sections }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analyze-sections error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
