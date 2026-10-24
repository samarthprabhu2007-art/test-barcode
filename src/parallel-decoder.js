import Quagga from "@ericblade/quagga2";

const patchSize = new URLSearchParams(window.location.search).get("patchSize");
let busy = false;

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;

  const message = event.data;
  if (message?.type !== "decode" || message.patchSize !== patchSize || busy) return;

  busy = true;
  try {
    const result = await Quagga.decodeSingle({
      src: message.imageDataUrl,
      inputStream: { size: 1600 },
      locate: message.locate,
      decoder: { readers: ["code_128_reader"], multiple: false },
      locator: { halfSample: message.halfSample, patchSize },
    });

    window.parent.postMessage({
      type: "decoded",
      patchSize,
      frameId: message.frameId,
      code: result?.codeResult?.code ?? "",
      format: result?.codeResult?.format ?? "",
    }, window.location.origin);
  } catch (error) {
    window.parent.postMessage({
      type: "decode-error",
      patchSize,
      frameId: message.frameId,
      error: error?.message ?? "Decoder failed",
    }, window.location.origin);
  } finally {
    busy = false;
  }
});

window.parent.postMessage({ type: "ready", patchSize }, window.location.origin);
