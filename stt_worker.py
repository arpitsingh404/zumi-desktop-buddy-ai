"""Zumi real-time speech-to-text worker (faster-whisper, persistent).

Keeps the model loaded in memory so each transcription is fast (~0.5-1s)
instead of paying a 1-2s model load on every utterance.

Protocol (line-delimited JSON over stdin/stdout):
  ready:  {"ready": true, "engine": "faster-whisper-base-int8"}
  req:    {"id": 1, "wav": "C:/path/to/file.wav", "lang": "en"}
  resp:   {"id": 1, "text": "open youtube", "ms": 640}
  error:  {"id": 1, "error": "message"}
  ping:   {"ping": true}  ->  {"pong": true}
"""
import json
import sys
import time
import wave
import os

MODEL_ENV = "ZUMI_WHISPER_MODEL"
MODEL_ID = os.environ.get(MODEL_ENV, "base")
DOWNLOAD_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "hf")


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def load_wav(path):
    """Read a 16-bit PCM wav into float32 mono numpy (no av/ffmpeg dependency)."""
    import numpy as np
    wf = wave.open(path, "rb")
    try:
        n = wf.getnframes()
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        raw = wf.readframes(n)
    finally:
        wf.close()
    if sw == 2:
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sw == 1:
        a = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 255.0 - 0.5
    else:
        raise ValueError("unsupported sample width %d" % sw)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        # cheap linear resample to 16k (whisper's native rate)
        import numpy as np
        duration = a.shape[0] / float(sr)
        target_n = int(round(duration * 16000))
        x_old = np.linspace(0.0, duration, num=a.shape[0], endpoint=False)
        x_new = np.linspace(0.0, duration, num=target_n, endpoint=False)
        a = np.interp(x_new, x_old, a).astype(np.float32)
        sr = 16000
    return a, sr


def main():
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover - dependency guard
        print(json.dumps({"fatal": "faster-whisper unavailable: %s" % e}), flush=True)
        return 2

    t0 = time.time()
    try:
        model = WhisperModel(MODEL_ID, device="cpu", compute_type="int8",
                             download_root=DOWNLOAD_ROOT, local_files_only=True)
    except Exception as e:
        log("local-only load failed (%s), retrying with download" % e)
        model = WhisperModel(MODEL_ID, device="cpu", compute_type="int8",
                             download_root=DOWNLOAD_ROOT)
    load_ms = int((time.time() - t0) * 1000)
    print(json.dumps({"ready": True, "engine": "faster-whisper-%s-int8" % MODEL_ID,
                      "modelMs": load_ms, "pid": os.getpid(), "ppid": os.getppid()}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            print(json.dumps({"error": "bad request"}), flush=True)
            continue
        if req.get("ping"):
            print(json.dumps({"pong": True}), flush=True)
            continue
        rid = req.get("id")
        path = req.get("wav")
        lang = req.get("lang") or "en"
        try:
            if not path or not os.path.exists(path):
                raise ValueError("wav file missing")
            audio, _sr = load_wav(path)
            t0 = time.time()
            segs, _info = model.transcribe(audio, language=lang, beam_size=5, vad_filter=True,
                                           condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segs).strip()
            ms = int((time.time() - t0) * 1000)
            print(json.dumps({"id": rid, "text": text, "ms": ms}), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "error": str(e)[:300]}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
