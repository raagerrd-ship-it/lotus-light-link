

# Visuella förbättringar — runda 3

Jag har granskat alla UI-komponenter och ser följande förbättringsmöjligheter:

## 1. Reconnecting-skärmen saknar fade-in
Connect-skärmen har `animate-fade-in` men reconnecting-skärmen poppar in utan transition. Bör ha samma fade-in.

## 2. Overlay-header och footer saknar kantlinje
Glasmorfism-panelerna (`backdrop-blur-lg`) flyter ihop med bakgrunden. En tunn `border-b border-white/5` på headern och `border-t border-white/5` på footern ger en subtil separation.

## 3. NowPlayingBar — progress-bar position
Progress-baren sitter under texten. Visuellt starkare om den ligger överst i baren (första barriären mot MicPanel-visualiseringen).

## 4. Connect-knappen — saknar hover-effekt
Primärknappen har inline `style` som överrider hover-states. Lägg till `hover:scale-[1.02]` och `active:scale-[0.98]` för taktil feedback.

## 5. MicPanel inaktiv — ikonen har hårdkodad opacity utan accent
Activity-ikonen när mikrofonen inte är aktiv har `opacity: 0.3` och ingen färg. Ge den en svag puls i accent-färgen istället för grå, som en "breathing" indikation att den väntar.

## 6. Safe-area padding
Appen körs som PWA på mobil. Headern och footern bör respektera safe-area-inset med `pt-[env(safe-area-inset-top)]` och `pb-[env(safe-area-inset-bottom)]`.

---

## Ändringar per fil

### `src/pages/Index.tsx`
- Reconnecting: lägg till `animate-fade-in`
- Overlay header: lägg till `border-b border-white/5` + `pt-[env(safe-area-inset-top)]`
- Overlay footer: lägg till `border-t border-white/5` + `pb-[env(safe-area-inset-bottom)]`
- Connect-knapp: lägg till `hover:scale-[1.02] active:scale-[0.98]`

### `src/components/NowPlayingBar.tsx`
- Flytta progress-bar div ovanför content-diven (från `mb-3` till `mb-3` men som första child)

### `src/components/MicPanel.tsx`
- Inaktiv Activity-ikon: byt från `opacity: 0.3, color: undefined` till `opacity: 0.4, color: rgb(currentColor)` + lägg till `animate-pulse` class

### `tailwind.config.ts`
- Verifiera att `fade-in` keyframe finns (behövs för reconnecting-skärmen)

---

Sex subtila men tydliga förbättringar. Ingen funktionell ändring.

