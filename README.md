# Code 128 scanner test

An isolated browser scanner test using Quagga2. Everything is kept in this folder; it is not wired into the main application.

## Run it

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite (usually `http://localhost:5173`). Camera permission is requested only after selecting **Start camera**. For phone testing, serve the page over HTTPS; browsers generally allow camera access on localhost without HTTPS.

## Included scanner settings

- Code 128 reader only; other barcode types are not enabled.
- 1600 px ideal camera width by default, with a UI setting for other widths.
- Locator on, half-sampling on, medium locator patches, matching the provided settings.
- Rear-facing camera preferred; camera selector appears after permission is granted.
- Torch toggle appears only when the active camera reports torch support.
- At most 10 decode attempts per second to limit unnecessary CPU/battery use.
- A camera value is added only after two matching detections. Each unique value is added once until **Scan again** or **Clear results** is selected.
- Manual entry and local image upload are available for testing.
- No barcode values or images are uploaded or persisted.

## Test checklist

Use the actual Code 128 card/barcode on the target phone. Try a clear/flat barcode, repeated visibility, different values, glare, low light, closer/farther distances, permission denial, stop/start, torch if available, image upload, and manual entry. This test page cannot run the phone’s physical camera in automated build checks; final read reliability needs your device test.
