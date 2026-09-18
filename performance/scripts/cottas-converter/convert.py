"""Convert JBR's N-Triples input with the reference COTTAS writer."""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile

import duckdb
import pycottas


def checksum(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def convert(directory):
    directory = directory.resolve()
    source = directory / "dataset.nt"
    target = directory / "dataset.cottas"
    manifest_path = directory / "dataset.cottas.json"
    policy = {
        "writer": "pycottas",
        "versions": {
            name: importlib.metadata.version(name)
            for name in ("pycottas", "duckdb", "pyoxigraph", "pandas", "numpy")
        },
        "index": "spo",
        "compression": "ZSTD",
        "compressionLevel": 22,
        "parquetVersion": "v2",
        "sourceSha256": checksum(source),
    }
    if target.is_file() and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if all(manifest.get(key) == value for key, value in policy.items()) and \
                manifest.get("outputSha256") == checksum(target):
            print(f"Reusing verified COTTAS file: {target}", flush=True)
            return

    print(f"Converting {source} with pycottas (SPO, ZSTD level 22)", flush=True)
    # pycottas uses a fixed database filename in disk mode. Keep it, spill files,
    # and partially written output in an isolated directory on the data volume.
    previous_directory = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="cottas-", dir=directory) as temporary:
        try:
            os.chdir(temporary)
            pycottas.rdf2cottas(str(source), "dataset.cottas", index="spo", disk=True)
            converted = Path(temporary) / "dataset.cottas"
            with duckdb.connect() as connection:
                columns = connection.execute(
                    "DESCRIBE SELECT * FROM read_parquet(?)", [str(converted)]
                ).fetchall()
                if [(column[0], column[1]) for column in columns] != [
                    ("s", "VARCHAR"), ("p", "VARCHAR"), ("o", "VARCHAR")
                ]:
                    raise ValueError(f"Unexpected COTTAS benchmark schema: {columns}")
                rows = connection.execute(
                    "SELECT count(*) FROM read_parquet(?)", [str(converted)]
                ).fetchone()[0]
                if rows == 0:
                    raise ValueError("The converted benchmark dataset is empty")
            manifest = {
                **policy,
                "triples": rows,
                "outputSha256": checksum(converted),
            }
            temporary_manifest = Path(temporary) / "dataset.cottas.json"
            temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
            converted.replace(target)
            temporary_manifest.replace(manifest_path)
        finally:
            os.chdir(previous_directory)
    print(f"Prepared {rows:,} triples: {target}", flush=True)


if __name__ == "__main__":
    convert(Path(sys.argv[1] if len(sys.argv) > 1 else "/data"))
