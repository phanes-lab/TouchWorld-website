#!/usr/bin/env python3
"""Export first-person trajectory candidates without repeating website demos."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import zarr


FPS = 30
OUTPUT_SIZE = (640, 360)
EXPORT_ALL_TASKS = {"insert_plug", "pull_tissue"}
WEBSITE_EPISODES = {
    "grasp_milktea_bottle": {0, 1, 2, 3},
    "grasp_water_bottle": {0, 1, 2, 3},
    "scrub_pan": {0, 12, 24, 36},
    "spray_water": {0, 1, 2, 3},
    "stack_cups": {0, 1, 2, 3},
    "wipe_cup": {0, 30, 60, 90},
}


def evenly_spaced_indices(candidates: list[int], count: int) -> list[int]:
    if len(candidates) <= count:
        return candidates
    positions = np.linspace(0, len(candidates) - 1, num=count)
    return [candidates[int(round(position))] for position in positions]


def write_video(group: Any, start: int, end: int, output_path: Path, crf: int) -> None:
    frames = group["data/camera_main_rgb"]
    source_height, source_width = frames.shape[1:3]
    command = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{source_width}x{source_height}",
        "-r",
        str(FPS),
        "-i",
        "-",
        "-an",
        "-vf",
        f"scale={OUTPUT_SIZE[0]}:{OUTPUT_SIZE[1]}:flags=lanczos",
        "-vcodec",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-preset",
        "veryfast",
        "-crf",
        str(crf),
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None

    try:
        for source_index in range(start, end):
            frame = np.asarray(frames[source_index], dtype=np.uint8)
            process.stdin.write(frame.tobytes())
        process.stdin.close()
    except BrokenPipeError as error:
        raise RuntimeError(f"ffmpeg stopped while writing {output_path}") from error

    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"ffmpeg failed for {output_path} with exit code {return_code}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default="/data_all/intern10/egoscale/ftp1-policy/data/wuji_stage2",
        help="Directory containing one Zarr dataset per task.",
    )
    parser.add_argument(
        "--output",
        default="/data_all/intern10/egoscale/ftp1-policy/tmp/choose_demo",
        help="Directory for task folders and encoded MP4 files.",
    )
    parser.add_argument("--count", type=int, default=20, help="Candidates per regular task.")
    parser.add_argument("--crf", type=int, default=23, help="H.264 CRF; lower means higher quality.")
    parser.add_argument("--overwrite", action="store_true", help="Re-encode MP4 files that already exist.")
    args = parser.parse_args()

    source_root = Path(args.source).expanduser().resolve()
    output_root = Path(args.output).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "source": str(source_root),
        "output": str(output_root),
        "fps": FPS,
        "resolution": list(OUTPUT_SIZE),
        "codec": "H.264/libx264",
        "crf": args.crf,
        "tasks": [],
    }

    for zarr_path in sorted(source_root.glob("*.zarr")):
        task_id = zarr_path.stem
        group = zarr.open(str(zarr_path), mode="r")
        episode_ends = np.asarray(group["meta/episode_ends"], dtype=np.int64)
        episode_count = len(episode_ends)
        excluded = set() if task_id in EXPORT_ALL_TASKS else WEBSITE_EPISODES.get(task_id, set())
        candidates = [episode_index for episode_index in range(episode_count) if episode_index not in excluded]
        selected = candidates if task_id in EXPORT_ALL_TASKS else evenly_spaced_indices(candidates, args.count)
        task_output = output_root / task_id
        task_output.mkdir(parents=True, exist_ok=True)
        task_manifest = {
            "id": task_id,
            "episodeCount": episode_count,
            "excludedWebsiteEpisodes": sorted(excluded),
            "selectedEpisodes": selected,
            "videos": [],
        }

        print(f"{task_id}: exporting {len(selected)} of {episode_count} episodes: {selected}", flush=True)
        for episode_index in selected:
            start = int(episode_ends[episode_index - 1]) if episode_index > 0 else 0
            end = int(episode_ends[episode_index])
            output_path = task_output / f"episode_{episode_index:03d}_main.mp4"
            if output_path.exists() and not args.overwrite:
                print(f"  Keeping existing {output_path.name}", flush=True)
            else:
                print(f"  Encoding {output_path.name}: {end - start} frames", flush=True)
                write_video(group, start, end, output_path, args.crf)
            task_manifest["videos"].append(
                {
                    "episodeIndex": episode_index,
                    "startFrame": start,
                    "endFrameExclusive": end,
                    "frameCount": end - start,
                    "durationSeconds": round((end - start) / FPS, 4),
                    "path": str(output_path.relative_to(output_root)),
                }
            )
        manifest["tasks"].append(task_manifest)

    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {manifest_path}", flush=True)


if __name__ == "__main__":
    main()
