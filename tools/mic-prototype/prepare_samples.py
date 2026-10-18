"""Prepare five public-domain Japanese readings for a wiring smoke test, not user accuracy acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import wave
from pathlib import Path
from urllib.request import urlopen

BASE = "https://kaiidams.github.io/Kokoro-Speech-Dataset/"
SAMPLES = [
    ("inakakyoshi-by-katai-tayama-04444.wav", "急いでこくじにおもむく姿がぞくぞくとして見られた。"),
    ("kokoro-by-soseki-natsume-02359.wav", "私は今度もあるいはそうなるかも知れないと思った。しかし医者は"),
    ("kusamakura-by-soseki-natsume-02836.wav", "真にこちゅうの消息を解し得たるものの嗤うはその意を得ている。"),
    ("meian-by-soseki-natsume-02997.wav", "着物も着換えずにまたひばちの前へ坐った。"),
    ("nowaki-by-soseki-natsume-01782.wav", "わがみのはかなくて、浮世の苦しみの骨に食い入るゆうべゆうべを知る。"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--replay", action="store_true", help="Also prepare 16 kHz PCM sequential replay with one-second gaps")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for name, reference in SAMPLES:
        path = args.output / name
        if not path.exists():
            with urlopen(BASE + name, timeout=30) as response:
                data = response.read(5 * 1024 * 1024)
            path.write_bytes(data)
        with wave.open(str(path), "rb") as audio:
            details = {"sampleRate": audio.getframerate(), "frames": audio.getnframes(),
                       "channels": audio.getnchannels(), "sampleWidth": audio.getsampwidth(),
                       "durationSeconds": audio.getnframes() / audio.getframerate()}
        records.append({"file": name, "source": BASE + name, "referenceJa": reference,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **details})
    manifest = {"dataset": "Kokoro Speech Dataset", "reader": "ekzemplaro / LibriVox",
                "source": "https://github.com/kaiidams/Kokoro-Speech-Dataset",
                "samplePage": BASE + "samples.html", "license": "Public domain per dataset author",
                "referenceNote": "Sample-page Japanese with spaces removed. Kana/kanji variants and partial sentences remain; not a human-verified evaluation gold standard.",
                "purpose": "Public recordings for prototype smoke tests; not the user's microphone, not live stream quality acceptance.",
                "samples": records}
    if args.replay:
        import numpy as np
        import soxr
        chunks = [np.zeros(16000, dtype=np.float32)]
        cursor = 16000
        for row in records:
            with wave.open(str(args.output / row["file"]), "rb") as audio:
                if audio.getsampwidth() != 2 or audio.getnchannels() != 1:
                    raise ValueError("Expected mono PCM16 public samples")
                data = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
                data = soxr.resample(data, audio.getframerate(), 16000, quality="HQ")
            row["replayStartSample"] = cursor
            cursor += len(data)
            row["replayEndSample"] = cursor
            chunks.extend((data, np.zeros(16000, dtype=np.float32)))
            cursor += 16000
        replay = args.output / "replay-16k.wav"
        with wave.open(str(replay), "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
            output.writeframes((np.clip(np.concatenate(chunks), -1, 1) * 32767).astype("<i2").tobytes())
        manifest["replay"] = {"file": replay.name, "sampleRate": 16000, "durationSeconds": cursor / 16000,
                              "sha256": hashlib.sha256(replay.read_bytes()).hexdigest(),
                              "processing": "SoXR HQ 22050 -> 16000; mono PCM16; one-second initial/inter-clip/final silence"}
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
