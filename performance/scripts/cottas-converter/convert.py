"""Convert JBR's N-Triples input with the reference COTTAS writer.

Writes one COTTAS file per index order. Each is a complete, valid COTTAS file; they
differ only in row order, which is what lets DuckDB prune row groups for a pattern
whose leading components are bound.
"""

import hashlib
import importlib.metadata
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile

import duckdb
import pycottas


def checksum(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


# The primary file keeps the plain name so that a single-index consumer still works.
INDEX_ORDERS = ("spog", "posg", "ospg")


def target_for(directory, order):
    return directory / ("dataset.cottas" if order == INDEX_ORDERS[0] else f"dataset.{order}.cottas")


def convert(directory):
    directory = directory.resolve()
    source = directory / "dataset.nt"
    manifest_path = directory / "dataset.cottas.json"
    policy = {
        "writer": "pycottas",
        "versions": {
            name: importlib.metadata.version(name)
            for name in ("pycottas", "duckdb", "pyoxigraph", "pandas", "numpy")
        },
        "indexes": list(INDEX_ORDERS),
        "compression": "ZSTD",
        "compressionLevel": 22,
        "parquetVersion": "v2",
        "sourceSha256": checksum(source),
    }
    targets = {order: target_for(directory, order) for order in INDEX_ORDERS}
    if all(path.is_file() for path in targets.values()) and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        digests = manifest.get("outputSha256", {})
        if all(manifest.get(key) == value for key, value in policy.items()) and \
                isinstance(digests, dict) and \
                all(digests.get(order) == checksum(path) for order, path in targets.items()):
            print(f"Reusing {len(targets)} verified COTTAS files in {directory}", flush=True)
            return

    print(f"Converting {source} with pycottas ({', '.join(INDEX_ORDERS)}, ZSTD level 22)", flush=True)
    # pycottas uses a fixed database filename in disk mode, so each order needs its own working
    # directory. Keep those, the spill files, and partially written output on the data volume.
    previous_directory = Path.cwd()
    digests = {}
    with tempfile.TemporaryDirectory(prefix="cottas-", dir=directory) as temporary:
        try:
            for order in INDEX_ORDERS:
                workdir = Path(temporary) / order
                workdir.mkdir()
                os.chdir(workdir)
                name = f"{order}.cottas"
                pycottas.rdf2cottas(str(source), name, index=order, disk=True)
                converted = workdir / name
                rows = validate(converted)
                digests[order] = checksum(converted)
                converted.replace(targets[order])
                print(f"  {order}: {rows:,} triples -> {targets[order].name}", flush=True)
                # Release the scratch database before converting the next order.
                os.chdir(temporary)
                shutil.rmtree(workdir, ignore_errors=True)
            manifest = {**policy, "triples": rows, "outputSha256": digests}
            temporary_manifest = Path(temporary) / "dataset.cottas.json"
            temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
            temporary_manifest.replace(manifest_path)
        finally:
            os.chdir(previous_directory)
    print(f"Prepared {rows:,} triples across {len(INDEX_ORDERS)} index orders", flush=True)


def validate(converted):
    """Check the schema and return the triple count."""
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
    return rows


if __name__ == "__main__":
    convert(Path(sys.argv[1] if len(sys.argv) > 1 else "/data"))
