## Mål

Exponera en high-water-mark av `controllerOutstandingCount` sedan engine-start, så att vi efter deploy direkt kan se om ACL-gaten någonsin nått sitt tak (6).

## Ändringar

**1. `pi/src/ble/state.ts`** — lägg till fält i `bleStats`:
```ts
outstandingMaxObserved: 0, // high-water mark sedan engine-start
```

**2. `pi/src/ble/protocol.ts`** — i `leaseAndDrainState()`, direkt efter `bleStats.controllerOutstandingCount = outstanding;`:
```ts
if (outstanding > bleStats.outstandingMaxObserved) {
  bleStats.outstandingMaxObserved = outstanding;
}
```

**3. `pi/src/ble/protocol.ts`** — i `resetLastSent()`: låt `outstandingMaxObserved` vara orörd (high-water är "sedan engine-start", inte "sedan senaste reconnect"). Ingen ändring behövs där.

## Verifiering

- `outstandingMaxObserved` syns automatiskt i `/api/status` (hela `bleStats` exponeras).
- Förväntat värde under normal drift: 1–3. Värde = 6 ⇒ gaten har nått taket minst en gång ⇒ tick-rate eller dynamics behöver tunas.

## Skip enligt din feedback

- Ingen `outstandingResetCount` (2c) — räknaren är derived från noble.
- Ingen 250 ms force-reset watchdog (5) — befintlig stuck-detection räcker.
- Ingen HCI Read Buffer Size-probe (1) — hårdvärdet 7 är korrekt för BCM43438.

Ingen ny memory-fil; uppdaterar endast `acl-outstanding-gate.md` med en rad om high-water-stat.