/**
 * acrIdentify — identifiera låt via ACRCloud från en WAV-snutt.
 *
 * Pi:n är en separat enhet → kräver ACRCLOUD_ACCESS_KEY/SECRET/HOST i sin EGEN
 * env (PCC/systemd-unit). Saknas de blir identify() en no-op som returnerar
 * null (loggar varning en gång), resten av systemet påverkas inte.
 */

import { createHmac } from 'crypto';

const ACCESS_KEY = process.env.ACRCLOUD_ACCESS_KEY ?? '';
const ACCESS_SECRET = process.env.ACRCLOUD_ACCESS_SECRET ?? '';
const HOST = process.env.ACRCLOUD_HOST ?? '';

let warnedMissing = false;

export function acrConfigured(): boolean {
  return !!(ACCESS_KEY && ACCESS_SECRET && HOST);
}

export interface AcrMatch {
  artist: string;
  track: string;
}

/** Skicka WAV till ACRCloud /v1/identify. null vid no-match/fel/saknad config. */
export async function identify(wav: Buffer): Promise<AcrMatch | null> {
  if (!acrConfigured()) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        '[ACR] ACRCLOUD_ACCESS_KEY/SECRET/HOST saknas i Pi-env — ' +
        'igenkänning avstängd. Sätt dem i PCC/systemd-unit.'
      );
    }
    return null;
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = ['POST', '/v1/identify', ACCESS_KEY, 'audio', '1', timestamp].join('\n');
    const signature = createHmac('sha1', ACCESS_SECRET).update(stringToSign).digest('base64');

    const form = new FormData();
    form.append('sample', new Blob([wav], { type: 'audio/wav' }), 'sample.wav');
    form.append('sample_bytes', String(wav.byteLength));
    form.append('access_key', ACCESS_KEY);
    form.append('data_type', 'audio');
    form.append('signature_version', '1');
    form.append('signature', signature);
    form.append('timestamp', timestamp);

    const res = await fetch(`https://${HOST}/v1/identify`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    const json: any = await res.json();

    const code = json?.status?.code;
    if (code !== 0) {
      console.log(`[ACR] No match (status ${code}: ${json?.status?.msg ?? 'okänt'})`);
      return null;
    }

    const music = json?.metadata?.music?.[0];
    const track = music?.title;
    const artist = music?.artists?.[0]?.name;
    if (!track) return null;

    return { artist: artist ?? '', track };
  } catch (e: any) {
    console.warn('[ACR] identify-fel:', e?.message ?? e);
    return null;
  }
}
