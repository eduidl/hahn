#!/usr/bin/env python3
"""Measure the real streaming endpoint using only the Python standard library."""
import argparse
import json
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("url")
parser.add_argument("--topic", required=True)
parser.add_argument("--field", action="append", required=True, help="Dot-separated numeric field path")
parser.add_argument("--start-ns")
parser.add_argument("--end-ns")
args = parser.parse_args()
payload = {"topic": args.topic, "fields": [field.split(".") for field in args.field]}
if args.start_ns is not None:
    payload["start_ns"] = args.start_ns
if args.end_ns is not None:
    payload["end_ns"] = args.end_ns
request = urllib.request.Request(args.url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
started = time.perf_counter()
first = None
total_bytes = rows = batches = 0
complete = False
with urllib.request.urlopen(request) as response:
    for line in response:
        total_bytes += len(line)
        event = json.loads(line)
        if event["type"] == "error":
            raise RuntimeError(event["message"])
        if event["type"] == "batch":
            if first is None:
                first = time.perf_counter() - started
            rows += len(event["rows"])
            batches += 1
        if event["type"] == "complete":
            complete = True
if not complete:
    raise RuntimeError("Stream ended before completion")
print(json.dumps({"first_batch_seconds": first, "total_seconds": time.perf_counter() - started, "bytes": total_bytes, "rows": rows, "batches": batches}, indent=2))
