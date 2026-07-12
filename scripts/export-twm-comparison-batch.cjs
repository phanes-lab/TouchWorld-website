#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "public/touchworld/twm_demos/manifest.json"));
const outputDir = path.resolve(process.env.OUTPUT_DIR || path.join(root, "exports/twm-comparison"));
const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 4));
const queue = [...manifest.episodes];
let running = 0;
let failed = false;

fs.mkdirSync(outputDir, { recursive: true });

function launchNext() {
  while (!failed && running < concurrency && queue.length) {
    const episode = queue.shift();
    running += 1;
    const child = spawn(process.execPath, [path.join(__dirname, "export-twm-comparison-media.cjs")], {
      cwd: root,
      env: { ...process.env, EPISODE_ID: episode.id, OUTPUT_DIR: outputDir },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      running -= 1;
      if (code !== 0) {
        failed = true;
        process.exitCode = code || 1;
        return;
      }
      if (!queue.length && running === 0) {
        fs.writeFileSync(
          path.join(outputDir, "export-summary.json"),
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              width: 925,
              fps: manifest.fps,
              episodeCount: manifest.episodes.length,
              subtaskCount: manifest.episodes.reduce((sum, item) => sum + item.subtasks.length, 0),
              formats: ["mp4", "gif"],
              episodes: manifest.episodes,
            },
            null,
            2,
          ),
        );
        console.log(`All exports completed: ${outputDir}`);
      } else {
        launchNext();
      }
    });
  }
}

launchNext();
