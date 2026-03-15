

## Ta bort färgkalibrering från mixerbordet

Färg-slidrarna (Gamma R/G/B, Offset R/G/B, Mättnad) gör inte nytta i sin nuvarande form — de justerar blint utan visuell referens.

### Ändring

**`src/components/CalibrationOverlay.tsx`** — Ta bort de 7 slider-definitionerna i `SLIDERS`-arrayen (rad 40–46): `gammaR`, `gammaG`, `gammaB`, `offsetR`, `offsetG`, `offsetB`, `saturationBoost`.

Kvar blir 7 sliders: Min/Max ljus, Attack, Release, Dynamik, Kick tröskel, Kick tid.

Värdena i `LightCalibration` och `DEFAULT_CALIBRATION` behålls orörda — de har vettiga defaults (gamma=1, offset=0, saturation=1) och används fortfarande i `applyColorCalibration()`. De exponeras bara inte längre i UI:t.

### Framtida möjlighet

Din idé om en guidad färgkalibrering (visa målfärg → justera tills slingan matchar → spara → nästa) kan byggas som ett separat steg-för-steg-flöde senare.

