/**
 * PermissionsBanner — visar varning + setup-kommando om Pi:n saknar
 * BLE/audio-rättigheter (typiskt efter PCC release där managed:false +
 * runInstallOnRelease:false hoppar över setup-lotus.sh).
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";

interface PermsResp {
  ok: boolean;
  rfkillAccess: boolean;
  rfkillError: string | null;
  groups: string[];
  hasNetdev: boolean;
  hasBluetooth: boolean;
  hasAudio: boolean;
  missing: string[];
  setupCommand: string;
}

const POLL_MS = 15_000;

export function PermissionsBanner({ piBase }: { piBase: string }) {
  const [perms, setPerms] = useState<PermsResp | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchPerms = async () => {
      try {
        const r = await fetch(`${piBase}/api/permissions`, { signal: AbortSignal.timeout(2500) });
        if (r.ok && !cancelled) setPerms(await r.json());
      } catch {}
    };
    fetchPerms();
    const id = setInterval(fetchPerms, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [piBase]);

  if (!perms || perms.ok) return null;

  const cmd = perms.setupCommand;
  const onCopy = async () => {
    let ok = false;
    // 1. Försök med modern Clipboard API (kräver https eller localhost)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cmd);
        ok = true;
      }
    } catch {}
    // 2. Fallback för http (typiskt fall: chrome på 192.168.x.x:3001)
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = cmd;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, cmd.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/10 text-[11px] overflow-hidden">
      <div className="px-3 py-2 border-b border-destructive/30 flex items-center gap-2">
        <AlertTriangle size={14} className="text-destructive shrink-0" />
        <span className="font-semibold uppercase tracking-wider text-[10px] text-destructive">
          Setup måste köras
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        <p className="text-foreground/80 leading-snug">
          Pi:n saknar systemrättigheter som krävs för BLE och mikrofon. PCC packade upp
          release-filerna men hoppade över setup-skriptet (managed:false).
        </p>
        <div className="text-[10px] opacity-80">
          <span className="font-medium">Saknas:</span>{" "}
          {perms.missing.map((m, i) => (
            <span key={m}>
              {i > 0 && ", "}
              <span className="font-mono text-destructive">{m}</span>
            </span>
          ))}
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider opacity-60 mb-1">
            Kör på Pi:n via SSH:
          </div>
          <div className="flex items-stretch gap-1.5">
            <code className="flex-1 px-2 py-1.5 rounded-md bg-background/60 border border-border font-mono text-[10px] text-foreground break-all">
              {cmd}
            </code>
            <button
              onClick={onCopy}
              className="px-2 rounded-md bg-primary/15 hover:bg-primary/25 text-primary text-[10px] font-semibold flex items-center gap-1 shrink-0"
              title="Kopiera"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? "Kopierad" : "Kopiera"}
            </button>
          </div>
          <div className="text-[9px] opacity-60 mt-1.5">
            Efter scriptet kört: <span className="font-mono">sudo reboot</span> (gruppändringar kräver ny session).
          </div>
        </div>
      </div>
    </div>
  );
}
