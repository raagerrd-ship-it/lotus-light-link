

# Visuella förbättringar — runda 4

## 1. Fade-in animation saknas i Tailwind config
`animate-fade-in` används på connect- och reconnect-skärmarna men keyframen finns inte i `tailwind.config.ts`. Den fungerar bara om `tailwindcss-animate` råkar inkludera den — bör definieras explicit.

## 2. Connect-knappen — text är för stor på liten viewport
Viewporten är 427×332. Knappen har `text-lg px-10 py-6` vilket äter mycket yta. Bör skalas ner till `text-base px-8 py-5` och `gap-10` mellan sektionerna kan bli `gap-8`.

## 3. Progress-bar i NowPlayingBar — ingen animation vid mount
Baren hoppar direkt till rätt bredd. Lägg till `will-change-[width]` och en initial `width: 0` via en kort delay för en smooth entry.

## 4. Header-knappar saknar visuell feedback vid tap
`variant="ghost"` ger bara hover-bg. Lägg till `active:scale-90 transition-transform` för taktil feedback på mobil.

## 5. BPM-badge i NowPlayingBar — kan ha accent-glow
BPM-badgen är `bg-secondary text-muted-foreground` — anonym. En svag `border` i accent-färg när BPM finns ger den mer liv.

## 6. Muted-foreground är för mörk
`--muted-foreground: 0 0% 33%` är väldigt låg kontrast (33% lightness mot 7% bakgrund). Höj till `0 0% 45%` för bättre läsbarhet av artist-namn och hjälptext.

---

## Ändringar per fil

### `tailwind.config.ts`
- Lägg till `fade-in` keyframe: `{ from: { opacity: 0 }, to: { opacity: 1 } }` och animation `fade-in 0.5s ease-out`

### `src/index.css`
- Ändra `--muted-foreground` från `0 0% 33%` till `0 0% 45%`

### `src/pages/Index.tsx`
- Connect-skärmen: `gap-10` → `gap-8`, knapp `text-lg px-10 py-6` → `text-base px-8 py-5`
- Header-knappar: lägg till `active:scale-90 transition-transform`

### `src/components/NowPlayingBar.tsx`
- BPM-badge: lägg till dynamisk `border` i accent-färg: `style={{ borderColor: \`rgba(\${r},\${g},\${b},0.3)\` }}` och `border` class

Sex subtila justeringar. Ingen funktionell ändring.

