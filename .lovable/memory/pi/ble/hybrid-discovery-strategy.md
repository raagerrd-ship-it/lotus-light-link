---
name: Hybrid BLE discovery strategy
description: bluetoothctl + noble parallel scan captures addressType metadata for scanless reconnection
type: feature
---
Systemet kör bluetoothctl och noble scan parallellt vid enhetsupptäckt.
- bluetoothctl ger pålitlig enhetslista (MAC + namn)
- noble ger addressType, connectable, serviceUuids — metadata som krävs för reconnect utan scan
- All metadata sparas persistent (ble-address-type, ble-connectable, ble-service-uuids)
- selectDevice använder cachad noble peripheral direkt om tillgänglig
- tryDirectConnect skickar savedAddressType till noble.connectAsync() vid reconnect
- Fallback addressType är 'random' (vanligast för BLEDOM-enheter)
