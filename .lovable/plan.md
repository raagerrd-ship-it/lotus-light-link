

# Visuella förbättringar — modernare och mer professionellt

Efter att ha granskat all UI-kod ser jag följande förbättringsmöjligheter:

## 1. Connect-skärmen — för mycket visuellt brus
- **Ta bort färgväljaren** från connect-skärmen. Den är ett implementation-detalj som stör det rena intrycket. Färgen sätts ändå automatiskt av albumart.
- **Förenkla knapphierarkin**: bara en primärknapp (senaste enhet eller "Anslut") och en diskret textlänk för "Sök alla". Tre knappar ser rörigt ut.
- **Flytta hjälptexten** ("Kräver Chrome...") till en liten `text-[10px]` footer istället för inline.
- **Lägg till en subtil fade-in** animation (`animate-fade-in`) på hela connect-containern.

## 2. NowPlayingBar — kan bli mer immersiv
- **Lägg till en tunn progress-linje** under now-playing som visar spelpositionen (baserad på `sonosPosition`). Ger känslan av en riktig mediaspelare.
- **Öka albumart-storlek** från `w-11 h-11` till `w-12 h-12` och använd `rounded-xl` istället för `rounded-lg`.

## 3. Overlay-header — för platt
- **Lägg till backdrop-blur** (`backdrop-blur-md`) på header och now-playing gradient för en frosted-glass-effekt istället för ren opacity-gradient.
- **Ersätt gradient-background** med `bg-background/60 backdrop-blur-lg` för ett modernare utseende.

## 4. MicPanel — inaktivt tillstånd ser dött ut
- **Byt ut texten** "Isolerar basfrekvenser..." mot bara en enkel tap-to-start-ikon med pulsande animation.
- Onödig förklaring för en dedikerad kontroller-app.

## 5. Typografi-detalj
- **Byt "Ljusår"-titeln** till `tracking-[0.2em] uppercase text-2xl font-bold` — mer logotypkänsla, mindre "rubrik".

---

## Ändringar per fil

### `src/pages/Index.tsx`
- Connect-skärmen: ta bort Select/färgväljare, förenkla till max 2 knappar + textlänk
- Titel: `tracking-[0.2em] uppercase text-2xl`
- Overlay header + bottom: `backdrop-blur-lg bg-background/50` istället för linear-gradient
- Lägg till `animate-fade-in` class på connect-container

### `src/components/NowPlayingBar.tsx`
- Albumart: `w-12 h-12 rounded-xl`
- Lägg till progress-bar under contentet: tunn (2px) linje med accent-färg, bredd baserat på ny prop `progressFraction`

### `src/components/MicPanel.tsx`
- Inaktivt tillstånd: ersätt förklaringstext med bara ikonen + `animate-pulse`, ingen text

### `tailwind.config.ts`
- Lägg till `fade-in` keyframe och animation om det saknas

Totalt fem filer, ren visuell polish utan beteendeändringar.

