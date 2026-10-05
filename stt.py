"""Zumi offline speech-to-text (Vosk).

Usage: python stt.py <wav_file> <model_dir>
Prints JSON: {"text": "..."}
"""
import sys
import json
import wave


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: stt.py <wav> <model_dir>"}))
        return
    wav_path, model_dir = sys.argv[1], sys.argv[2]
    try:
        import vosk
    except Exception as e:
        print(json.dumps({"error": "vosk not installed: %s" % e}))
        return

    vosk.SetLogLevel(-1)
    try:
        wf = wave.open(wav_path, "rb")
    except Exception as e:
        print(json.dumps({"error": "cannot open wav: %s" % e}))
        return

    if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
        print(json.dumps({"error": "wav must be 16-bit mono"}))
        return

    try:
        model = vosk.Model(model_dir)
    except Exception as e:
        print(json.dumps({"error": "cannot load model: %s" % e}))
        return

    rec = vosk.KaldiRecognizer(model, wf.getframerate())
    parts = []
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            parts.append(json.loads(rec.Result()).get("text", ""))
    parts.append(json.loads(rec.FinalResult()).get("text", ""))
    print(json.dumps({"text": " ".join(p for p in parts if p).strip()}))


if __name__ == "__main__":
    main()
