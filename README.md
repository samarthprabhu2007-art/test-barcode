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
- Parallel processing is on by default. It captures one 1600 px camera frame and sends that same frame to four separate Quagga2 decoders using small, medium, large, and extra-large patches.
- Switch to **Single** if the camera preview or phone feels slow. Single mode uses the selected patch size and the live camera decoder only.
- Single mode checks up to 5 frames per second to reduce CPU load. Parallel mode dispatches frames to the four decoders at most 4 times per second; each decoder skips new work while still processing its previous frame.
- An RVCE-shaped Code 128 value is accepted on its first read. Any other Code 128 value must match across two distinct camera frames; multiple patch-size decoders reading one frame count as one read.
- Each unique value is added once until **Scan again** or **Clear results** is selected.
- Manual entry and local image upload are available for testing.
- No barcode values or images are uploaded or persisted.
- Parallel decoding uses extra CPU and battery. Compare both modes on the actual phones before relying on the scanner operationally.

## Test checklist

Use the actual Code 128 card/barcode on the target phone. Try a clear/flat barcode, repeated visibility, different values, glare, low light, closer/farther distances, permission denial, stop/start, torch if available, image upload, and manual entry. This test page cannot run the phone’s physical camera in automated build checks; final read reliability needs your device test.
