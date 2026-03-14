const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { track, artist } = await req.json();

    if (!track || !artist) {
      return new Response(
        JSON.stringify({ success: false, error: 'track and artist are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('RAPIDAPI_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'RAPIDAPI_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const url = `https://track-analysis.p.rapidapi.com/pktx/analysis?artist=${encodeURIComponent(artist)}&song=${encodeURIComponent(track)}`;
    console.log('[track-analysis] Fetching:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'track-analysis.p.rapidapi.com',
        'x-rapidapi-key': apiKey,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Track Analysis API error:', response.status, data);
      return new Response(
        JSON.stringify({ success: false, error: `API error ${response.status}` }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract BPM from response
    const bpm = data?.tempo ?? data?.bpm ?? null;
    const energy = data?.energy ?? null;
    const danceability = data?.danceability ?? null;
    const key = data?.key ?? null;

    return new Response(
      JSON.stringify({ success: true, bpm, energy, danceability, key, raw: data }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in track-analysis:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
