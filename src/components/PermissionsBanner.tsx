/**
 * PermissionsBanner — visar varning + setup-kommando om Pi:n saknar
 * BLE/audio-rättigheter (typiskt efter PCC release där managed:false +
 * runInstallOnRelease:false hoppar över setup-lotus.sh).
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Check, PlayCircle, Loader2 } from "lucide-react";

interface SelfTestStep {
  step: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}
interface SelfTestResp {
  ok: boolean;
  durationMs: number;
  steps: SelfTestStep[];
}

// Mappar tekniska "missing"-strängar till läsbar orsak + hint till PCC/setup.
function explainMissing(m: string): { reason: string; hint: string } {
  if (m.includes("PCC_DATA_DIR") || m.includes("PCC_CONFIG_DIR")) return { reason: "Engine saknar skrivåtkomst till appens sparmapp", hint: "Kör chown/chmod på exakt katalogen som visas här; update/setup fixar detta automatiskt." };
  if (m.includes("rfkill"))        return { reason: "Ingen skrivåtkomst till /dev/rfkill", hint: "PCC-tjänsten behöver netdev-grupp + udev-regel (setup-lotus.sh skriver den)." };
  if (m.includes("netdev"))        return { reason: "Process saknar netdev-grupp",         hint: "Lägg till 'netdev' i PCC service.json → permissions, eller kör setup för standalone." };
  if (m.includes("bluetooth-grupp"))return { reason: "Process saknar bluetooth-grupp",     hint: "Lägg till 'bluetooth' i PCC service.json → permissions." };
  if (m.includes("audio-grupp"))   return { reason: "Process saknar audio-grupp (ALSA)",   hint: "Lägg till 'audio' i PCC service.json → permissions." };
  if (m.includes("CAP_NET_RAW"))   return { reason: "Saknar CAP_NET_RAW (HCI-socket)",     hint: "PCC ska sätta AmbientCapabilities=CAP_NET_RAW eller setcap node-binär." };
  if (m.includes("CAP_NET_ADMIN")) return { reason: "Saknar CAP_NET_ADMIN (HCI-config)",   hint: "PCC ska sätta AmbientCapabilities=CAP_NET_ADMIN." };
  if (m.includes("bluetoothd"))    return { reason: "bluetoothd-tjänsten är inte aktiv",   hint: "Kör: sudo systemctl enable --now bluetooth" };
  if (m.includes("noble adapter")) return { reason: "BLE-adaptern är inte poweredOn",      hint: "Kontrollera 'rfkill list bluetooth' + 'hciconfig hci0 up'." };
  return { reason: m, hint: "Kör setup-skriptet nedan." };
}

interface PermsResp {
  ok: boolean;
  rfkillAccess: boolean;
  rfkillError: string | null;
  groups: string[];
  hasNetdev: boolean;
  hasBluetooth: boolean;
  hasAudio: boolean;
  hasNetRaw?: boolean;
  hasNetAdmin?: boolean;
  bluetoothdActive?: boolean;
  bluetoothdStatus?: string;
  nobleState?: string;
  nodeCaps?: string | null;
  missing: string[];
  setupCommand: string;
}

const POLL_MS = 15_000;

export function PermissionsBanner({ piBase }: { piBase: string }) {
  const [perms, setPerms] = useState<PermsResp | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SelfTestResp | null>(null);

  const runSelfTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`${piBase}/api/permissions/ble-selftest`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) setTestResult(await r.json());
      else setTestResult({ ok: false, durationMs: 0, steps: [{ step: "http", ok: false, detail: `HTTP ${r.status}` }] });
    } catch (e: any) {
      setTestResult({ ok: false, durationMs: 0, steps: [{ step: "fetch", ok: false, detail: e?.message ?? String(e) }] });
    } finally {
      setTesting(false);
    }
  };

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

  // Filtrera bort "noble adapter state=…" — den missingen är förväntad innan
  // BLE-motorn startats (adaptern power:as upp först då). Visa bara rutan om
  // det finns RIKTIGA permission-problem (rfkill, grupp, caps, bluetoothd).
  const realMissing = perms.missing.filter((m) => !m.includes("noble adapter"));
  if (realMissing.length === 0) return null;

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
        <div className="space-y-1.5">
          <div className="text-[9px] uppercase tracking-wider opacity-60">Saknas ({realMissing.length})</div>
          <ul className="space-y-1">
            {realMissing.map((m) => {
              const { reason, hint } = explainMissing(m);
              return (
                <li key={m} className="rounded-md bg-background/40 border border-border/50 px-2 py-1.5">
                  <div className="font-mono text-[10px] text-destructive">{m}</div>
                  <div className="text-[10px] text-foreground/80 mt-0.5">{reason}</div>
                  <div className="text-[9px] opacity-60 mt-0.5">→ {hint}</div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* BLE self-test */}
        <div className="rounded-md bg-background/40 border border-border/50 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[9px] uppercase tracking-wider opacity-60">BLE self-test</div>
            <button
              onClick={runSelfTest}
              disabled={testing}
              className="px-2 py-1 rounded-md bg-primary/15 hover:bg-primary/25 disabled:opacity-50 text-primary text-[10px] font-semibold flex items-center gap-1"
            >
              {testing ? <Loader2 size={11} className="animate-spin" /> : <PlayCircle size={11} />}
              {testing ? "Testar…" : "Kör test"}
            </button>
          </div>
          {testResult && (
            <div className="space-y-1">
              <div className={`text-[10px] font-semibold ${testResult.ok ? "text-green-500" : "text-destructive"}`}>
                {testResult.ok ? "✓ OK" : "✗ Misslyckades"} ({testResult.durationMs}ms)
              </div>
              <ul className="space-y-0.5">
                {testResult.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[10px]">
                    <span className={s.ok ? "text-green-500" : "text-destructive"}>{s.ok ? "✓" : "✗"}</span>
                    <span className="font-mono opacity-80">{s.step}</span>
                    {s.ms !== undefined && <span className="opacity-50">({s.ms}ms)</span>}
                    {s.detail && <span className="opacity-70 ml-1">— {s.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
