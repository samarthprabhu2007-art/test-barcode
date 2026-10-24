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
  processingMode: document.querySelector("#processingModeButton"),
  processingModeValue: document.querySelector("#processingModeValue"),
  processingModeHelp: document.querySelector("#processingModeHelp"),
  decoderPool: document.querySelector("#decoderPool"),
};

const PATCH_SIZES = ["small", "medium", "large", "x-large"];
const PARALLEL_FRAME_INTERVAL = 250;
const state = {
  starting: false,
  running: false,
  stopRequested: false,
  handlerAttached: false,
  processedHandlerAttached: false,
  processingMode: "parallel",
  decoderFrames: new Map(),
  frameSequence: 0,
  currentFrameId: 0,
  parallelTimer: null,
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
  elements.processingMode.disabled = starting;
  for (const control of [elements.resolution, elements.patchSize, elements.halfSample, elements.locate]) {
    control.disabled = starting || running;
  }
  elements.camera.disabled = starting;
}

function updateProcessingModeUI() {
  const isParallel = state.processingMode === "parallel";
  elements.processingMode.setAttribute("aria-pressed", String(isParallel));
  elements.processingMode.textContent = isParallel ? "Switch to single" : "Switch to parallel";
  elements.processingModeValue.textContent = isParallel ? "Parallel - all patch sizes" : "Single - selected patch size";
  elements.processingModeHelp.textContent = isParallel
    ? "Tries small, medium, large, and extra-large patches at 1600 px."
    : `Uses the ${elements.patchSize.value} patch size at 1600 px.`;
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

function finishCameraScan(code) {
  if (state.scanFinalizing) return;
  state.candidate = null;
  addResult(code, "camera");
  state.scanFinalizing = true;
  void stopCamera({ updateMessage: false }).then(() => {
    setStatus("Scan complete. Press Scan again to start the camera.", "success");
    window.alert(`${isRvceIdFormat(code) ? "RVCE ID" : "Code 128"} detected:\n\n${code}`);
    state.scanFinalizing = false;
  });
}

function acceptCameraDetection(code, frameId) {
  if (!state.running || state.scanFinalizing || !code) return;
  if (isRvceIdFormat(code)) {
    finishCameraScan(code);
    return;
  }

  const now = Date.now();
  if (state.candidate?.value === code && now - state.candidate.firstSeen < 1800) {
    state.candidate.frameIds.add(frameId);
    state.candidate.lastSeen = now;
  } else {
    state.candidate = { value: code, frameIds: new Set([frameId]), firstSeen: now, lastSeen: now };
  }

  if (state.candidate.frameIds.size >= 2) {
    finishCameraScan(code);
  } else {
    setStatus("Barcode seen; hold it steady for one more read to confirm.", "scanning");
  }
}

function onDetected(result) {
  if (state.processingMode === "parallel") return;
  const code = result?.codeResult?.code;
  const format = result?.codeResult?.format;
  if (!code || format !== "code_128") return;
  acceptCameraDetection(code, state.currentFrameId);
}

function onProcessed() {
  if (!state.running || state.processingMode !== "single") return;
  state.currentFrameId = ++state.frameSequence;
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
    frequency: state.processingMode === "parallel" ? 1 : 5,
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

function onParallelMessage(event) {
  const decoder = [...state.decoderFrames.values()].find((item) => item.iframe.contentWindow === event.source);
  if (!decoder || event.origin !== window.location.origin || event.data?.patchSize !== decoder.patchSize) return;

  if (event.data.type === "ready") {
    decoder.ready = true;
    clearTimeout(decoder.timeout);
    decoder.resolve();
    return;
  }

  if (event.data.type === "decoded" && event.data.format === "code_128" && event.data.code) {
    acceptCameraDetection(event.data.code, event.data.frameId);
  }
}

function cleanupParallelDecoders() {
  if (state.parallelTimer !== null) {
    clearInterval(state.parallelTimer);
    state.parallelTimer = null;
  }
  for (const decoder of state.decoderFrames.values()) {
    clearTimeout(decoder.timeout);
    if (!decoder.ready) decoder.reject(new Error("Parallel decoder was stopped."));
    decoder.iframe.remove();
  }
  state.decoderFrames.clear();
}

function initializeParallelDecoders() {
  cleanupParallelDecoders();
  const workerPatchSizes = PATCH_SIZES;
  return Promise.all(workerPatchSizes.map((patchSize) => new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.title = `Code 128 ${patchSize} patch decoder`;
    const decoder = { patchSize, iframe, ready: false, resolve, reject, timeout: null };
    decoder.timeout = setTimeout(() => reject(new Error(`${patchSize} decoder did not start.`)), 10000);
    state.decoderFrames.set(patchSize, decoder);
    iframe.src = `/decoder.html?patchSize=${encodeURIComponent(patchSize)}`;
    elements.decoderPool.append(iframe);
  })));
}

function dispatchParallelFrame(frameId) {
  if (state.decoderFrames.size === 0) return;
  const source = elements.scanner.querySelector("video");
  if (!source) return;

  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  if (!width || !height) return;

  const snapshot = document.createElement("canvas");
  snapshot.width = width;
  snapshot.height = height;
  const context = snapshot.getContext("2d", { willReadFrequently: false });
  if (!context) return;

  try {
    context.drawImage(source, 0, 0, width, height);
    snapshot.toBlob((imageBlob) => {
      if (!imageBlob || !state.running || state.processingMode !== "parallel") return;
      const reader = new FileReader();
      reader.onload = () => {
        if (!state.running || state.processingMode !== "parallel") return;
        for (const decoder of state.decoderFrames.values()) {
          if (!decoder.ready) continue;
          decoder.iframe.contentWindow?.postMessage({
            type: "decode",
            patchSize: decoder.patchSize,
            frameId,
            imageDataUrl: reader.result,
            locate: elements.locate.checked,
            halfSample: elements.halfSample.checked,
          }, window.location.origin);
        }
      };
      reader.readAsDataURL(imageBlob);
    }, "image/jpeg", 0.84);
  } catch {
    // A frame that cannot be copied is skipped; the live Quagga reader remains active.
  }
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
  if (state.processedHandlerAttached) {
    Quagga.offProcessed(onProcessed);
    state.processedHandlerAttached = false;
  }
  cleanupParallelDecoders();

  try {
    await Quagga.stop();
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
  state.frameSequence = 0;
  state.currentFrameId = 0;
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
      Quagga.onProcessed(onProcessed);
      state.processedHandlerAttached = true;
      Quagga.start();
      state.running = true;
      elements.placeholder.hidden = true;
      setControls({ starting: false, running: true });
      setStatus("Scanning the full camera frame for CODE 128…", "scanning");
      const activeTrack = Quagga.CameraAccess.getActiveTrack();
      const activeDeviceId = activeTrack?.getSettings?.().deviceId ?? "";
      await refreshCameras(activeDeviceId);
      if (!state.running) return;
      updateTorchAvailability();
      if (state.processingMode === "parallel") {
        try {
          await initializeParallelDecoders();
          if (state.running) {
            state.parallelTimer = setInterval(() => {
              dispatchParallelFrame(++state.frameSequence);
            }, PARALLEL_FRAME_INTERVAL);
            setStatus("Parallel scan active across all patch sizes.", "scanning");
          }
        } catch {
          cleanupParallelDecoders();
          if (!state.running) return;
          state.processingMode = "single";
          updateProcessingModeUI();
          state.starting = true;
          setControls({ starting: true, running: true });
          await stopCamera({ updateMessage: false });
          state.starting = false;
          startCamera();
        }
      }
    } catch (startError) {
      await stopCamera({ updateMessage: false });
      setControls({ starting: false, running: false });
      setStatus(formatCameraError(startError), "error");
    }
  });
}

async function toggleProcessingMode() {
  if (state.starting) return;
  const wasRunning = state.running;
  state.processingMode = state.processingMode === "parallel" ? "single" : "parallel";
  updateProcessingModeUI();
  if (!wasRunning) return;

  state.starting = true;
  setControls({ starting: true, running: true });
  await stopCamera({ updateMessage: false });
  state.starting = false;
  startCamera();
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
elements.processingMode.addEventListener("click", () => void toggleProcessingMode());
elements.scanAgain.addEventListener("click", scanAgain);
elements.clear.addEventListener("click", clearResults);
elements.addManual.addEventListener("click", addManualValue);
elements.manual.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addManualValue();
});
elements.image.addEventListener("change", () => scanImage(elements.image.files?.[0]));
elements.patchSize.addEventListener("change", updateProcessingModeUI);
elements.torch.addEventListener("change", () => void toggleTorch(elements.torch.checked));
elements.camera.addEventListener("change", async () => {
  if (!state.running) return;
  await stopCamera({ updateMessage: false });
  startCamera();
});

window.addEventListener("pagehide", () => void stopCamera({ updateMessage: false }));
window.addEventListener("message", onParallelMessage);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.running) {
    void stopCamera();
  }
});

renderResults();
updateProcessingModeUI();
