import Quagga from "@ericblade/quagga2";
import "./style.css";

const elements = {
  scanner: document.querySelector("#scanner"),
  placeholder: document.querySelector("#cameraPlaceholder"),
  status: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  start: document.querySelector("#startButton"),
  stop: document.querySelector("#stopButton"),
  scanAgain: document.querySelector("#scanAgainButton"),
  clear: document.querySelector("#clearButton"),
  resolution: document.querySelector("#resolutionSelect"),
  patchSize: document.querySelector("#patchSizeSelect"),
  camera: document.querySelector("#cameraSelect"),
  halfSample: document.querySelector("#halfSampleToggle"),
  locate: document.querySelector("#locateToggle"),
  torch: document.querySelector("#torchToggle"),
  results: document.querySelector("#resultsList"),
  resultCount: document.querySelector("#resultCount"),
  manual: document.querySelector("#manualValue"),
  addManual: document.querySelector("#addManualButton"),
  image: document.querySelector("#imageInput"),
  imageStatus: document.querySelector("#imageStatus"),
};

const state = {
  starting: false,
  running: false,
  stopRequested: false,
  handlerAttached: false,
  scanFinalizing: false,
  candidate: null,
  scannedValues: new Set(),
  entries: [],
};

function setStatus(message, kind = "idle") {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot status-${kind}`;
}

function setControls({ starting = state.starting, running = state.running } = {}) {
  elements.start.disabled = starting || running;
  elements.stop.disabled = !starting && !running;
  for (const control of [elements.resolution, elements.patchSize, elements.halfSample, elements.locate]) {
    control.disabled = starting || running;
  }
  elements.camera.disabled = starting;
}

function formatCameraError(error) {
  const name = error?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found. Connect a camera or use image upload/manual entry.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The camera is busy or could not start. Close other camera apps and try again.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "This camera cannot provide the selected resolution. Choose a lower resolution and retry.";
  }
  if (!window.isSecureContext) {
    return "Camera access requires localhost or HTTPS. Open this app on localhost or its HTTPS address.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support camera access. Try a current Chrome or Safari browser.";
  }
  return error?.message || "The camera could not start. Try again or use image upload/manual entry.";
}

function renderResults() {
  elements.results.replaceChildren();
  elements.resultCount.textContent = String(state.entries.length);

  if (state.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No barcodes scanned yet.";
    elements.results.append(empty);
    return;
  }

  for (const entry of [...state.entries].reverse()) {
    const row = document.createElement("article");
    row.className = "result-item";
    const value = document.createElement("code");
    value.textContent = entry.value;
    const meta = document.createElement("span");
    meta.textContent = `${entry.source} · ${entry.time}`;
    row.append(value, meta);
    elements.results.append(row);
  }
}

function addResult(value, source) {
  const cleanValue = String(value ?? "").trim();
  if (!cleanValue) return false;

  const format = source === "camera" || source === "photo" ? "code_128" : "manual";
  const alreadyInSession = state.scannedValues.has(cleanValue);
  if (alreadyInSession && source !== "manual") {
    setStatus(`Already scanned this value: ${cleanValue}`, "success");
    return false;
  }

  state.scannedValues.add(cleanValue);
  state.entries.push({
    value: cleanValue,
    format,
    source: source === "camera" ? "Camera · CODE 128" : source === "photo" ? "Photo · CODE 128" : "Manual entry",
    time: new Date().toLocaleTimeString(),
  });
  renderResults();
  setStatus(`Read ${format === "code_128" ? "CODE 128" : "manual value"}: ${cleanValue}`, "success");
  return true;
}

function isRvceIdFormat(value) {
  return /^RVCE\d{2}[A-Z]{3}\d{3}$/i.test(value.trim());
}

function onDetected(result) {
  if (!state.running || state.scanFinalizing) return;
  const code = result?.codeResult?.code;
  const format = result?.codeResult?.format;
  if (!code || format !== "code_128") return;

  if (isRvceIdFormat(code)) {
    state.candidate = null;
    addResult(code, "camera");
    state.scanFinalizing = true;
    void stopCamera({ updateMessage: false }).then(() => {
      setStatus("Scan complete. Press Scan again to start the camera.", "success");
      window.alert(`RVCE ID barcode detected:\n\n${code}`);
      state.scanFinalizing = false;
    });
    return;
  }

  const now = Date.now();
  if (state.candidate?.value === code && now - state.candidate.lastSeen < 1800) {
    state.candidate.hits += 1;
    state.candidate.lastSeen = now;
  } else {
    state.candidate = { value: code, hits: 1, lastSeen: now };
  }

  if (state.candidate.hits >= 2) {
    addResult(code, "camera");
    state.candidate = null;
    state.scanFinalizing = true;
    void stopCamera({ updateMessage: false }).then(() => {
      setStatus("Scan complete. Press Scan again to start the camera.", "success");
      window.alert(`Code 128 detected:\n\n${code}`);
      state.scanFinalizing = false;
    });
  } else {
    setStatus("Barcode seen; hold it steady for one more read to confirm.", "scanning");
  }
}

function scannerConfig() {
  const width = Number(elements.resolution.value);
  const height = Math.round((width * 9) / 16);
  const chosenCamera = elements.camera.value;
  return {
    inputStream: {
      name: "Live camera",
      type: "LiveStream",
      target: elements.scanner,
      constraints: {
        width: { ideal: width },
        height: { ideal: height },
        ...(chosenCamera ? { deviceId: { exact: chosenCamera } } : { facingMode: { ideal: "environment" } }),
      },
    },
    locate: elements.locate.checked,
    frequency: 10,
    decoder: {
      readers: ["code_128_reader"],
      multiple: false,
      debug: { drawBoundingBox: false, drawScanline: false, printReaderInfo: false },
    },
    locator: {
      halfSample: elements.halfSample.checked,
      patchSize: elements.patchSize.value,
    },
    debug: false,
  };
}

async function refreshCameras(activeDeviceId = "") {
  try {
    const cameras = await Quagga.CameraAccess.enumerateVideoDevices();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Rear camera (automatic)";
    elements.camera.replaceChildren(automatic);

    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label?.trim() || `Camera ${index + 1}`;
      elements.camera.append(option);
    });

    if (activeDeviceId && cameras.some((camera) => camera.deviceId === activeDeviceId)) {
      elements.camera.value = activeDeviceId;
    }
  } catch {
    // Device enumeration is an enhancement; facingMode environment still selects the rear camera.
  }
}

function updateTorchAvailability() {
  try {
    const track = Quagga.CameraAccess.getActiveTrack();
    const supported = Boolean(track?.getCapabilities?.().torch);
    elements.torch.disabled = !supported;
    if (!supported) elements.torch.checked = false;
  } catch {
    elements.torch.disabled = true;
    elements.torch.checked = false;
  }
}

async function stopCamera({ updateMessage = true } = {}) {
  state.stopRequested = true;
  state.running = false;
  state.candidate = null;
  setControls({ starting: state.starting, running: false });
  elements.torch.checked = false;
  elements.torch.disabled = true;

  if (state.handlerAttached) {
    Quagga.offDetected(onDetected);
    state.handlerAttached = false;
  }

  try {
    Quagga.stop();
  } catch {
    // stop() may be called after failed initialization; releasing below is still useful.
  }
  try {
    await Quagga.CameraAccess.release();
  } catch {
    // Camera may already have been released by Quagga.stop().
  }

  elements.scanner.querySelectorAll("video, canvas").forEach((node) => node.remove());
  elements.placeholder.hidden = false;
  if (updateMessage) setStatus("Camera stopped and released.", "idle");
}

function startCamera() {
  if (state.starting || state.running) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(formatCameraError(), "error");
    return;
  }

  state.starting = true;
  state.stopRequested = false;
  state.candidate = null;
  setControls({ starting: true, running: false });
  setStatus("Requesting camera permission…", "scanning");

  Quagga.init(scannerConfig(), async (error) => {
    state.starting = false;
    if (error) {
      await stopCamera({ updateMessage: false });
      setControls({ starting: false, running: false });
      setStatus(formatCameraError(error), "error");
      return;
    }

    if (state.stopRequested) {
      await stopCamera({ updateMessage: false });
      return;
    }

    try {
      Quagga.onDetected(onDetected);
      state.handlerAttached = true;
      Quagga.start();
      state.running = true;
      elements.placeholder.hidden = true;
      setControls({ starting: false, running: true });
      setStatus("Scanning the full camera frame for CODE 128…", "scanning");
      const activeTrack = Quagga.CameraAccess.getActiveTrack();
      const activeDeviceId = activeTrack?.getSettings?.().deviceId ?? "";
      await refreshCameras(activeDeviceId);
      updateTorchAvailability();
    } catch (startError) {
      await stopCamera({ updateMessage: false });
      setControls({ starting: false, running: false });
      setStatus(formatCameraError(startError), "error");
    }
  });
}

async function toggleTorch(enabled) {
  try {
    if (enabled) await Quagga.CameraAccess.enableTorch();
    else await Quagga.CameraAccess.disableTorch();
    setStatus(enabled ? "Torch is on." : "Torch is off.", "scanning");
  } catch {
    elements.torch.checked = false;
    setStatus("This camera or browser could not toggle its torch.", "error");
  }
}

function scanAgain() {
  state.scannedValues.clear();
  state.candidate = null;
  if (state.running) setStatus("Ready for a new scan. Hold a barcode steady in the camera view.", "scanning");
  else {
    setStatus("Starting the camera for another scan...", "scanning");
    startCamera();
  }
}

function clearResults() {
  state.entries = [];
  state.scannedValues.clear();
  state.candidate = null;
  renderResults();
  setStatus(state.running ? "Results cleared. Scanner is still running." : "Results cleared.", state.running ? "scanning" : "idle");
}

function addManualValue() {
  const value = elements.manual.value.trim();
  if (!value) {
    elements.manual.focus();
    setStatus("Enter a barcode value first.", "error");
    return;
  }
  addResult(value, "manual");
  elements.manual.value = "";
}

function scanImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    elements.imageStatus.textContent = "Choose an image file.";
    return;
  }

  const imageUrl = URL.createObjectURL(file);
  elements.imageStatus.textContent = "Checking image for a Code 128 barcode…";
  elements.image.disabled = true;
  try {
    Quagga.decodeSingle(
      {
        src: imageUrl,
        inputStream: { size: 1600 },
        locate: elements.locate.checked,
        decoder: { readers: ["code_128_reader"], multiple: false },
        locator: { halfSample: elements.halfSample.checked, patchSize: elements.patchSize.value },
      },
      (result) => {
        URL.revokeObjectURL(imageUrl);
        elements.image.disabled = false;
        if (result?.codeResult?.format === "code_128" && result.codeResult.code) {
          addResult(result.codeResult.code, "photo");
          elements.imageStatus.textContent = "Code 128 decoded from the image.";
        } else {
          elements.imageStatus.textContent = "No Code 128 barcode found. Try a sharper, well-lit photo with the full barcode visible.";
        }
        elements.image.value = "";
      },
    );
  } catch (error) {
    URL.revokeObjectURL(imageUrl);
    elements.image.disabled = false;
    elements.image.value = "";
    elements.imageStatus.textContent = error?.message || "Could not process this image. Try another file.";
  }
}

elements.start.addEventListener("click", startCamera);
elements.stop.addEventListener("click", () => void stopCamera());
elements.scanAgain.addEventListener("click", scanAgain);
elements.clear.addEventListener("click", clearResults);
elements.addManual.addEventListener("click", addManualValue);
elements.manual.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addManualValue();
});
elements.image.addEventListener("change", () => scanImage(elements.image.files?.[0]));
elements.torch.addEventListener("change", () => void toggleTorch(elements.torch.checked));
elements.camera.addEventListener("change", async () => {
  if (!state.running) return;
  await stopCamera({ updateMessage: false });
  startCamera();
});

window.addEventListener("pagehide", () => void stopCamera({ updateMessage: false }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.running) {
    void stopCamera();
  }
});

renderResults();
