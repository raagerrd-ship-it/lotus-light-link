

## Problem
Engine bootar Sonos + alsaMic + configServer även när noble's `stateChange` inte landat. Resultat: 325s innan noble vaknar i engine-processen, och under tiden är allt annat igång "i onödan" eftersom vi inte kan styra lampan ändå.

## Lösning: Block-tills-noble-redo boot
Ändra `pi/src/index.ts` så att boot **stannar** tills noble faktiskt rapporterar `poweredOn`. Inget annat (alsaMic, Sonos, mic, engine.start) startas innan dess.

### Ändringar i `pi/src/index.ts` (STEP B.1 och framåt)

1. **Förläng noble-väntan från 5s → tills `poweredOn`** (med säkerhets-tak, t.ex. 60s).
2. **Loopa tills `poweredOn`**: Om första `waitForPoweredOnAsync(60000)` failar, logga tydligt "BLE inte redo — fortsätter vänta" och försök igen. Engine bootar ALDRIG vidare utan noble.
3. **Heartbeat under väntan**: Logga var 5:e sekund `[Boot] Väntar på noble poweredOn (t+Xs)` så vi ser i UI:t att det inte är hängt.
4. **Behåll configServer-start TIDIGT** (rad ~210) så `/api/ble/diagnostics` och `/events` fungerar under väntan — UI:t ska kunna visa "Bootar: väntar på BLE…".
5. **Exposera boot-fas i diagnostics**: Lägg till `bootPhase: 'waiting-for-noble' | 'ready'` i `ble/state.ts` så UI kan visa status.

### Ny boot-ordning
```text
1. hci0 UP-check (befintligt)
2. import nobleBle
3. configServer START (för UI-status under väntan)
4. VÄNTA på noble.poweredOn (block, ingen timeout för att gå vidare)
5. import alsaMic + apply settings
6. start Sonos poller
7. start mic
8. engine.start()
9. Logga "✓ All systems running"
```

### UI-bit (PiMobile)
Visa boot-fas i status-pillen: "Bootar: väntar på Bluetooth…" tills `bootPhase === 'ready'`. Befintlig diagnostics-endpoint räcker.

### Vad detta löser
- Inget mer "noble unknown" i connect — när engine säger sig vara redo så ÄR noble redo.
- Sonos/mic/engine slösar inte CPU under boot-racet.
- Användaren ser tydligt "väntar på BLE" istället för förvirrande connect-fail.
- Eliminerar libuv-racen permanent eftersom alsaMic (den största native-blockern) laddas EFTER noble vaknat — vilket var hela poängen från första början, men med 5s-timeout som gav upp för tidigt.

### Filer som ändras
- `pi/src/index.ts` — boot-loop med oändlig väntan + heartbeat
- `pi/src/ble/state.ts` — `bootPhase` field + getter
- `pi/src/configServer.ts` — exponera `bootPhase` i `/api/ble/diagnostics` (om inte redan)
- `src/pages/PiMobile.tsx` — visa "Bootar: väntar på BLE…" pill

