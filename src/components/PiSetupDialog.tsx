import { useState } from "react";
import { HardDrive, X, Copy, Check, ExternalLink, ChevronDown, ChevronUp, Zap } from "lucide-react";

const REPO = "raagerrd-ship-it/lotus-light-link";
const REPO_URL = `https://github.com/${REPO}`;

type Section = { title: string; icon: string; steps: Step[] };
type Step = { title: string; content?: React.ReactNode; code?: string };

const sections: Section[] = [
  {
    title: "Ny installation",
    icon: "📦",
    steps: [
      {
        title: "1. Flasha SD-kort",
        content: (
          <>
            <p>Ladda ner <a href="https://www.raspberrypi.com/software/" target="_blank" rel="noopener" className="underline text-primary">Raspberry Pi Imager</a> och välj <strong>RPi OS Lite (64-bit)</strong>.</p>
            <p className="mt-1">I ⚙️ inställningar: hostname = <code>lotus</code>, aktivera SSH, WiFi.</p>
          </>
        ),
      },
      {
        title: "2. Koppla INMP441-mikrofonen",
        content: (
          <pre className="text-[10px] leading-snug whitespace-pre overflow-x-auto">
{`INMP441        RPi Zero 2 W
VDD    → 3.3V  (pin 1)
GND    → GND   (pin 6)
SCK    → GPIO 18  (pin 12)
WS     → GPIO 19  (pin 35)
SD     → GPIO 20  (pin 38)
L/R    → GND`}
          </pre>
        ),
      },
      {
        title: "3. Installera via SSH",
        code: `export REPO_URL="${REPO_URL}.git"\ncurl -fsSL "https://raw.githubusercontent.com/${REPO}/main/pi/setup-lotus.sh" | sudo bash`,
      },
      {
        title: "4. Starta om & verifiera",
        code: `sudo reboot\n# Vänta ~30s, sedan:\ncurl http://lotus.local:3001/api/status`,
      },
    ],
  },
  {
    title: "OS redan installerat",
    icon: "⚡",
    steps: [
      {
        title: "1. SSH:a in till Pi:n",
        content: <p>Om du redan har RPi OS igång med SSH och WiFi, logga in:</p>,
        code: `ssh pi@lotus.local\n# eller: ssh pi@<pi-ip-adress>`,
      },
      {
        title: "2. Installera beroenden",
        content: <p>Setup-scriptet hanterar allt — Node.js 20, BLE, ALSA, I²S overlay:</p>,
        code: `sudo apt-get install -y git\ngit clone ${REPO_URL}.git /opt/lotus-light\ncd /opt/lotus-light\nsudo bash pi/setup-lotus.sh`,
      },
      {
        title: "3. Koppla mikrofonen & starta om",
        content: (
          <>
            <p>Koppla INMP441 enligt pinout ovan (se "Ny installation" steg 2), sedan:</p>
          </>
        ),
        code: `sudo reboot`,
      },
      {
        title: "4. Starta & verifiera",
        code: `sudo systemctl start lotus-light\nsudo systemctl status lotus-light\ncurl http://lotus.local:3001/api/status`,
      },
    ],
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={handleCopy} className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-white/10 transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
    </button>
  );
}

export default function PiSetupDialog() {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      {/* Trigger icon */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center bg-foreground/5 border border-foreground/10 backdrop-blur-md hover:bg-foreground/10 active:scale-90 transition-all"
        title="Raspberry Pi Setup"
      >
        <HardDrive className="w-4 h-4 text-muted-foreground" />
      </button>

      {/* Modal */}
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
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Installera Lotus Light Link på en Raspberry Pi Zero 2 W för headless drift med automatiska uppdateringar via GitHub.
              </p>

              {/* Section tabs */}
              <div className="flex gap-2">
                {sections.map((sec, si) => (
                  <button
                    key={si}
                    onClick={() => { setActiveSection(si); setExpanded(null); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                      activeSection === si
                        ? 'bg-primary/10 text-primary border border-primary/20'
                        : 'bg-foreground/5 text-muted-foreground border border-foreground/5 hover:bg-foreground/8'
                    }`}
                  >
                    <span>{sec.icon}</span>
                    <span>{sec.title}</span>
                  </button>
                ))}
              </div>

              {/* Active section steps */}
              <div className="space-y-2">
                {sections[activeSection].steps.map((step, i) => {
                  const key = `${activeSection}-${i}`;
                  return (
                    <div key={key} className="rounded-xl border border-foreground/5 overflow-hidden">
                      <button
                        onClick={() => setExpanded(expanded === key ? null : key)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-foreground/3 transition-colors"
                      >
                        <span className="text-sm font-medium">{step.title}</span>
                        {expanded === key
                          ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                          : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        }
                      </button>
                      {expanded === key && (
                        <div className="px-4 pb-4 text-xs text-foreground/80 space-y-2">
                          {step.content}
                          {step.code && (
                            <div className="relative rounded-lg bg-foreground/5 p-3 pr-8 font-mono text-[10px] leading-relaxed overflow-x-auto">
                              <CopyButton text={step.code.replace(/\\n/g, '\n')} />
                              {step.code.split('\\n').map((line, j) => (
                                <div key={j}>{line}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Auto-update info */}
              <div className="rounded-xl border border-foreground/5 p-4">
                <h3 className="text-sm font-medium mb-1.5">🔄 Auto-uppdatering</h3>
                <p className="text-xs text-muted-foreground">
                  En systemd-timer kollar GitHub var 5:e minut. Vid ändringar i <code>pi/</code> eller <code>engine/</code> körs automatiskt: pull → build → restart.
                </p>
              </div>

              {/* Links */}
              <div className="flex gap-2 pt-1">
                <a href={REPO_URL} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <ExternalLink className="w-3 h-3" /> GitHub Repo
                </a>
                <a href={`${REPO_URL}/blob/main/pi/README.md`} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <ExternalLink className="w-3 h-3" /> Full dokumentation
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
