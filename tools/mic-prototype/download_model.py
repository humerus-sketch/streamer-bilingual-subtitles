"""Fetch one pinned public ASR model; never uses a Hugging Face account token."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

REPOSITORY = "Systran/faster-whisper-large-v3"
FILES = ["config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", help="Immutable commit; latest metadata is resolved once if omitted")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "download-manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
    revision = args.revision or (previous or {}).get("revision")
    if not revision:
        with urlopen(f"https://huggingface.co/api/models/{REPOSITORY}", timeout=30) as response:
            revision = json.load(response)["sha"]
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Expected an immutable 40-character repository commit")
    if previous and previous["revision"] != revision:
        raise ValueError("Use a new output directory for another model revision")
    print(json.dumps({"event": "download_start", "repository": REPOSITORY, "revision": revision}), flush=True)
    with urlopen(f"https://huggingface.co/api/models/{REPOSITORY}/revision/{revision}?blobs=true", timeout=30) as response:
        metadata = {row["rfilename"]: row for row in json.load(response)["siblings"]}
    records = []
    for name in FILES:
        path = output / name
        if not path.exists():
            part = path.with_name(path.name + ".download-part")
            # Windows curl uses the working public HTTPS route; no account or Xet CAS.
            subprocess.run(["curl.exe", "--location", "--fail", "--retry", "1", "--connect-timeout", "20",
                            "--max-time", "1200", "--continue-at", "-", "--output", str(part),
                            f"https://huggingface.co/{REPOSITORY}/resolve/{revision}/{name}"], check=True)
            verify_asset(part, metadata[name])
            part.rename(path)
        if not path.is_file():
            raise FileNotFoundError(f"Missing model file: {name}")
        verify_asset(path, metadata[name])
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        records.append({"file": name, "bytes": path.stat().st_size, "sha256": digest})
    manifest = {"repository": REPOSITORY, "revision": revision, "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "authentication": "public HTTPS; no account token", "files": records}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"event": "download_complete", "manifest": str(manifest_path),
                      "bytes": sum(row["bytes"] for row in records)}), flush=True)


def verify_asset(path: Path, metadata: dict) -> None:
    if path.stat().st_size != metadata["size"]:
        raise ValueError(f"Model file size mismatch; preserved for inspection: {path.name}")
    if metadata.get("lfs"):
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        expected = metadata["lfs"]["sha256"]
    else:
        actual = hashlib.sha1(f"blob {path.stat().st_size}\0".encode() + path.read_bytes()).hexdigest()
        expected = metadata["blobId"]
    if actual != expected:
        raise ValueError(f"Model content hash mismatch; preserved for inspection: {path.name}")


if __name__ == "__main__":
    main()
