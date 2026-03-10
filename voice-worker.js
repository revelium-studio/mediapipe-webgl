import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

let transcriber = null;
let busy = false;

self.addEventListener("message", async (e) => {
  const { type } = e.data;

  if (type === "load") {
    try {
      self.postMessage({ type: "status", msg: "Downloading Whisper model (~50 MB, cached after first load)..." });

      transcriber = await pipeline(
        "automatic-speech-recognition",
        "onnx-community/whisper-tiny.en",
        {
          progress_callback: (info) => {
            if (info.status === "progress" && info.progress != null) {
              self.postMessage({ type: "progress", pct: Math.round(info.progress) });
            }
          },
        }
      );

      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", msg: String(err) });
    }
  }

  if (type === "transcribe") {
    if (!transcriber || busy) return;
    busy = true;
    try {
      const result = await transcriber(e.data.audio);
      const text = (result.text || "").trim();
      if (text) self.postMessage({ type: "result", text });
    } catch (_) {}
    busy = false;
  }
});
