import { useState } from "react";
import { HardDrive, X, Copy, Check, ExternalLink, ChevronDown, ChevronUp, Terminal } from "lucide-react";

const REPO = "raagerrd-ship-it/lotus-light-link";
const REPO_URL = `https://github.com/${REPO}`;

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="relative rounded-lg bg-foreground/5 p-3 pr-9 font-mono text-[11px] leading-relaxed overflow-x-auto">
      <button onClick={handleCopy} className="absolute top-2 right-2 p-1 rounded hover:bg-white/10 transition-colors">
        {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {text.split('\n').map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

function Expandable({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-foreground/5 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-foreground/3 transition-colors"
      >
        {icon}
        <span className="text-sm font-medium flex-1">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-4 text-xs text-foreground/80 space-y-3">{children}</div>}
    </div>
  );
}

export default function PiSetupDialog() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center bg-foreground/5 border border-foreground/10 backdrop-blur-md hover:bg-foreground/10 active:scale-90 transition-all"
        title="Raspberry Pi Setup"
      >
        <HardDrive className="w-4 h-4 text-muted-foreground" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-foreground/10 bg-background/95 backdrop-blur-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-foreground/5 bg-background/90 backdrop-blur-lg rounded-t-2xl">
              <div className="flex items-center gap-2.5">
                <HardDrive className="w-5 h-5 text-primary" />
                <h2 className="text-base font-semibold">Pi Setup Guide</h2>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 rounded-full hover:bg-foreground/10 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 py-4 space-y-4">
              <p className="text-xs text-muted-foreground">
                Installera Lotus Light Link på en Raspberry Pi Zero 2 W. Du behöver en annan dator för att ansluta via SSH.
              </p>

              {/* SSH help */}
              <Expandable title="Hur aktiverar och använder jag SSH?" icon={<Terminal className="w-4 h-4 text-primary" />}>
                <div>
                  <p className="font-semibold text-foreground/90 mb-1">Aktivera SSH</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li><strong>Raspberry Pi Imager</strong> — klicka ⚙ och bocka i "Enable SSH". Enklast!</li>
                    <li><strong>Redan flashat?</strong> — Skapa en tom fil <code className="bg-foreground/5 px-1 rounded">ssh</code> i boot-partitionen.</li>
                    <li><strong>Med skärm</strong> — <code className="bg-foreground/5 px-1 rounded">sudo raspi-config</code> → Interface → SSH → Enable.</li>
                  </ul>
                </div>
                <div>
                  <p className="font-semibold text-foreground/90 mb-1">Hitta din Pi</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>Kolla routern efter <code className="bg-foreground/5 px-1 rounded">raspberrypi</code></li>
                    <li>Eller: <code className="bg-foreground/5 px-1 rounded">ping raspberrypi.local</code></li>
                  </ul>
                </div>
                <div>
                  <p className="font-semibold text-foreground/90 mb-1">Anslut</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li><strong>Mac / Linux</strong> — Öppna Terminal</li>
                    <li><strong>Windows</strong> — PowerShell eller <a href="https://putty.org" target="_blank" rel="noopener" className="text-primary underline">PuTTY</a></li>
                    <li>Standard-lösenord: <code className="bg-foreground/5 px-1 rounded">raspberry</code></li>
                  </ul>
                </div>
              </Expandable>

              {/* Steps */}
              <div className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">1. Anslut till din Pi via SSH</span>
                  <CopyBlock text="ssh pi@<pi-ip>" />
                </div>
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">2. Klona och installera</span>
                  <CopyBlock text={`git clone ${REPO_URL}.git\ncd lotus-light-link\nsudo bash pi/setup-lotus.sh`} />
                </div>
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">3. Koppla INMP441-mikrofon & starta om</span>
                  <pre className="text-[10px] leading-snug whitespace-pre overflow-x-auto bg-foreground/5 rounded-lg p-3 mb-2">
{`INMP441        RPi Zero 2 W
VDD    → 3.3V  (pin 1)
GND    → GND   (pin 6)
SCK    → GPIO 18  (pin 12)
WS     → GPIO 19  (pin 35)
SD     → GPIO 20  (pin 38)
L/R    → GND`}
                  </pre>
                  <CopyBlock text="sudo reboot" />
                </div>
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">4. Verifiera</span>
                  <CopyBlock text="curl http://lotus.local:3001/api/status" />
                </div>
              </div>

              {/* What the script does */}
              <div className="rounded-xl border border-foreground/5 p-4 bg-foreground/[0.02]">
                <p className="text-xs font-semibold text-foreground/80 mb-1.5">Vad scriptet gör:</p>
                <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5">
                  <li>Installerar Node.js 20, Git, ALSA och BLE-beroenden</li>
                  <li>Aktiverar I²S overlay för INMP441-mikrofon</li>
                  <li>Skapar systemd-tjänst (<code className="bg-foreground/5 px-1 rounded">lotus-light</code>)</li>
                  <li>Auto-update timer — kollar GitHub var 5:e minut</li>
                </ul>
              </div>

              {/* Troubleshooting */}
              <Expandable title="🛠 Felsökning" icon={null}>
                {[
                  { label: "Loggar (live)", cmd: "journalctl -u lotus-light -f" },
                  { label: "Service-status", cmd: "systemctl status lotus-light" },
                  { label: "Mic-test", cmd: "arecord -D plughw:0 -c1 -r16000 -f S16_LE -d5 /tmp/test.wav && aplay /tmp/test.wav" },
                  { label: "I²S overlay aktiv?", cmd: "arecord -l" },
                  { label: "BLE-skanning", cmd: "sudo hcitool lescan --passive" },
                  { label: "BLE-adapter", cmd: "hciconfig hci0" },
                  { label: "Uppdateringslogg", cmd: "journalctl -u lotus-update -n 20" },
                  { label: "Manuell uppdatering", cmd: "sudo bash /opt/lotus-light/pi/update-services.sh" },
                ].map((item, i) => (
                  <div key={i}>
                    <p className="text-xs font-medium text-foreground/70 mb-1">{item.label}</p>
                    <CopyBlock text={item.cmd} />
                  </div>
                ))}
              </Expandable>

              {/* Links */}
              <div className="flex gap-3 pt-1">
                <a href={REPO_URL} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <ExternalLink className="w-3 h-3" /> GitHub
                </a>
                <a href={`${REPO_URL}/blob/main/pi/README.md`} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <ExternalLink className="w-3 h-3" /> Dokumentation
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
