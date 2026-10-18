"""Run local-model checks with public WAV only, never open an input device."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import threading
import time


def run_check(command, output: Path, name: str):
    gpu = []
    baseline = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True).strip()
    started = time.perf_counter()
    with (output / f"{name}.stderr.txt").open("w", encoding="utf-8") as errors:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=errors, text=True, encoding="utf-8")
        def monitor():
            while child.poll() is None:
                try:
                    data = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], text=True)
                    memory, utilization, temperature = [int(v.strip()) for v in data.strip().split(",")]
                    gpu.append({"elapsedSeconds": time.perf_counter()-started, "usedMiB": memory,
                                "utilizationPercent": utilization, "temperatureC": temperature})
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass
                time.sleep(.8)
        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        events = []
        with (output / f"{name}.jsonl").open("w", encoding="utf-8") as stream:
            for line in child.stdout:
                stream.write(line); stream.flush()
                event = json.loads(line)
                events.append(event)
                if event["type"] in {"asr_result", "doctor_complete", "worker_error", "session_stopped"}:
                    print(json.dumps({"check": name, **event}, ensure_ascii=False), flush=True)
        code = child.wait()
        thread.join(timeout=3)
    metrics = {"name": name, "exitCode": code, "wallSeconds": time.perf_counter()-started,
               "baselineWholeGpuMiB": int(baseline), "sampledPeakWholeGpuMiB": max((r["usedMiB"] for r in gpu), default=None),
               "gpuSampling": "~0.8s polling; whole GPU, not allocator exact peak", "gpu": gpu,
               "microphoneOpened": False, "events": len(events)}
    (output / f"{name}.metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--audio-file", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    worker = Path(__file__).with_name("worker.py")
    base = [sys.executable, "-X", "utf8", str(worker)]
    results = []
    for mode, precision in (("doctor", "int8_float16"), ("file", "int8_float16"), ("file", "float16")):
        command = base + [mode, "--model-dir", args.model_dir, "--compute-type", precision]
        if mode == "file":
            command += ["--audio-file", args.audio_file, "--realtime"]
        result = run_check(command, args.output, f"{mode}-{precision}")
        results.append(result)
        if result["exitCode"]:
            break
    summary = {"at": datetime.now(timezone.utc).isoformat(), "source": "Public-domain Kokoro recordings, no microphone capture",
               "checks": results, "accuracy": "Human review pending; no user-speech accuracy claim", "cloudTranslation": "not part of this local check"}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if all(r["exitCode"] == 0 for r in results) else 1)


if __name__ == "__main__":
    main()
