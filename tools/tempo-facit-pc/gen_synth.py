"""Syntetisk korpus med kant tempo (filnamn = BPM). Kick 80 Hz + hi-hat, som PC-testet, 30 s @48 kHz."""
import numpy as np, soundfile as sf, os
sr = 48000; rng = np.random.default_rng(7); out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpus-synth'); os.makedirs(out, exist_ok=True)
def kick(L=6000):
    t = np.arange(L) / sr; return (np.sin(2*np.pi*80*t*np.exp(-t*8)) * np.exp(-t*18) + 0.3*np.exp(-t*400)*rng.standard_normal(L)).astype(np.float32)
def hat(L=1200, amp=0.5):
    n = rng.standard_normal(L+1); return (amp * np.diff(n) * np.exp(-np.arange(L)/300)).astype(np.float32)
def snare(L=4000):
    t = np.arange(L) / sr; return (0.6*np.exp(-t*30)*rng.standard_normal(L) + 0.4*np.sin(2*np.pi*180*t)*np.exp(-t*40)).astype(np.float32)
def song(bpm, hats='8', kick_every=1, snare24=False, swing=0.0):
    n = sr*30; y = np.zeros(n, np.float32); per = 60/bpm; t = 0.0; k = 0
    while t*sr + 6000 < n:
        if k % kick_every == 0: i = int(t*sr); y[i:i+6000] += kick() * (1.0 if k % 4 == 0 else 0.8)
        if snare24 and k % 2 == 1: i = int(t*sr); y[i:i+4000] += snare()
        if hats == '8':
            j = int((t + per*(0.5 + swing))*sr)
            if j + 1200 < n: y[j:j+1200] += hat()
        elif hats == '16':
            for q in (0.25, 0.5, 0.75):
                j = int((t+per*q)*sr)
                if j + 1200 < n: y[j:j+1200] += hat(amp=0.4)
        t += per; k += 1
    return y + (0.005*rng.standard_normal(n)).astype(np.float32)
cases = [(92, '8', 1, False, 0), (123, '8', 1, True, 0), (168, '8', 1, False, 0), (86, '16', 1, False, 0), (172, '8', 1, False, 0), (110, '8', 2, True, 0), (100, '8', 1, True, 0.17), (140, '8', 1, True, 0)]
for bpm, hats, ke, sn, sw in cases:
    name = f"{bpm}_hats{hats}_kick{ke}{'_snare' if sn else ''}{'_swing' if sw else ''}.wav"
    sf.write(os.path.join(out, name), song(bpm, hats, ke, sn, sw), sr, subtype='PCM_16'); print('skrev', name)
