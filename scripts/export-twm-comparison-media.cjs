#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const playwrightRoot = process.env.PLAYWRIGHT_ROOT;
if (!playwrightRoot) {
  throw new Error("PLAYWRIGHT_ROOT must point to the Playwright package directory");
}
const { chromium } = require(playwrightRoot);

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "public/touchworld/twm_demos/manifest.json"));
const outputRoot = path.resolve(process.env.OUTPUT_DIR || path.join(root, "exports/twm-comparison"));
const framesRoot = path.resolve(process.env.FRAMES_DIR || "/tmp/twm-comparison-frames");
const pageUrl = process.env.PAGE_URL || "http://127.0.0.1:3000/TouchWorld-website";
const onlyEpisode = process.env.EPISODE_ID || "";
const onlySubtask = process.env.SUBTASK_INDEX === undefined ? null : Number(process.env.SUBTASK_INDEX);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function assetFile(assetPath) {
  return path.join(root, "public", assetPath.replace(/^\//, ""));
}

function dataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function setRenderedFrames(page, groundTruthFrame, predictedFrame, progress) {
  await page.evaluate(
    async ({ groundTruthFrameUrl, predictedFrameUrl, nextProgress }) => {
      const urls = [groundTruthFrameUrl, predictedFrameUrl];
      const cards = Array.from(document.querySelectorAll("#twm-prediction-demos .twm-comparison__video"));
      await Promise.all(
        cards.map(async (card, index) => {
          const video = card.querySelector("video");
          if (video) {
            video.pause();
            video.style.visibility = "hidden";
          }
          card.style.position = "relative";
          let overlay = card.querySelector(".twm-export-frame");
          if (!overlay) {
            overlay = document.createElement("img");
            overlay.className = "twm-export-frame";
            Object.assign(overlay.style, {
              position: "absolute",
              left: "0",
              bottom: "0",
              zIndex: "2",
              display: "block",
              width: "100%",
              aspectRatio: "640 / 352",
              objectFit: "contain",
              background: "#050505",
            });
            card.appendChild(overlay);
          }
          overlay.src = urls[index];
          await overlay.decode();
        }),
      );

      const controls = document.querySelector("#twm-prediction-demos .twm-comparison__controls");
      const percent = controls?.querySelector(":scope > span");
      if (percent) percent.textContent = `${Math.round(nextProgress * 100)}%`;
      const progressBar = controls?.querySelector(".twm-comparison__progress");
      progressBar?.style.setProperty("--twm-comparison-progress", `${nextProgress * 100}%`);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    {
      groundTruthFrameUrl: dataUrl(groundTruthFrame),
      predictedFrameUrl: dataUrl(predictedFrame),
      nextProgress: progress,
    },
  );
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(framesRoot, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  console.log("Browser started");
  const page = await browser.newPage({ viewport: { width: 925, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10_000);
  await page.route("**/*", (route) => {
    const request = route.request();
    const isHeavyAsset = request.resourceType() === "image" || request.resourceType() === "media";
    if (isHeavyAsset && !request.url().includes("/touchworld/twm_demos/")) {
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  console.log("Page loaded");
  await page.locator("#twm-prediction-demos .twm-comparison__surface").waitFor();
  await page.evaluate(() => document.fonts.ready);
  console.log("Component and fonts ready");

  await page.addStyleTag({
    content: `
      html, body { margin: 0 !important; overflow: hidden !important; background: #f6f6ef !important; }
      #twm-prediction-demos > .twm-comparison__head,
      #twm-prediction-demos > .twm-comparison__tabs,
      #twm-prediction-demos > figcaption {
        display: none !important;
      }
      #twm-prediction-demos {
        position: fixed !important;
        inset: 0 auto auto 0 !important;
        z-index: 2147483647 !important;
        width: 925px !important;
        margin: 0 !important;
        background: #f6f6ef !important;
      }
    `,
  });

  const figure = page.locator("#twm-prediction-demos");
  const figureHeight = Math.ceil(await figure.evaluate((element) => element.getBoundingClientRect().height));
  await page.setViewportSize({ width: 925, height: figureHeight });
  console.log(`Capture size: 925x${figureHeight}`);

  const episodes = manifest.episodes.filter((episode) => !onlyEpisode || episode.id === onlyEpisode);
  let completed = 0;
  const total = episodes.reduce(
    (count, episode) => count + episode.subtasks.filter((subtask) => onlySubtask === null || subtask.index === onlySubtask).length,
    0,
  );

  for (const episode of episodes) {
    const episodeIndex = manifest.episodes.findIndex((item) => item.id === episode.id);
    await page.locator(".twm-comparison__tabs button").nth(episodeIndex).evaluate((button) => button.click());
    console.log(`Selected ${episode.id}`);

    for (const subtask of episode.subtasks) {
      if (onlySubtask !== null && subtask.index !== onlySubtask) continue;

      const subtaskLabel = String(subtask.index + 1).padStart(2, "0");
      await page.locator(".twm-comparison__subtasks button").nth(subtask.index).click();
      console.log(`Capturing ${episode.id}/subtask_${subtaskLabel}`);

      const frameDir = path.join(framesRoot, episode.id, `subtask_${subtaskLabel}`);
      const sourceFrameDir = path.join(frameDir, "source");
      const outputDir = path.join(outputRoot, episode.id);
      fs.rmSync(frameDir, { recursive: true, force: true });
      fs.mkdirSync(sourceFrameDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });

      run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-i", assetFile(subtask.groundTruth),
        "-vf", `fps=${episode.fps}`, "-frames:v", String(subtask.frameCount), "-start_number", "0",
        path.join(sourceFrameDir, "ground_truth_%05d.png"),
      ]);
      run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-i", assetFile(subtask.predicted),
        "-vf", `fps=${episode.fps}`, "-frames:v", String(subtask.frameCount), "-start_number", "0",
        path.join(sourceFrameDir, "predicted_%05d.png"),
      ]);

      for (let frame = 0; frame < subtask.frameCount; frame += 1) {
        const frameNumber = String(frame).padStart(5, "0");
        await setRenderedFrames(
          page,
          path.join(sourceFrameDir, `ground_truth_${frameNumber}.png`),
          path.join(sourceFrameDir, `predicted_${frameNumber}.png`),
          subtask.frameCount > 1 ? frame / (subtask.frameCount - 1) : 0,
        );
        await figure.screenshot({ path: path.join(frameDir, `frame_${String(frame).padStart(5, "0")}.png`) });
      }

      const baseName = `subtask_${subtaskLabel}`;
      const inputPattern = path.join(frameDir, "frame_%05d.png");
      const mp4Path = path.join(outputDir, `${baseName}.mp4`);
      const gifPath = path.join(outputDir, `${baseName}.gif`);
      const palettePath = path.join(frameDir, "palette.png");

      run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-framerate", String(episode.fps), "-i", inputPattern,
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path,
      ]);
      run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-framerate", String(episode.fps), "-i", inputPattern,
        "-vf", "palettegen=stats_mode=diff:max_colors=256", palettePath,
      ]);
      run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-framerate", String(episode.fps), "-i", inputPattern,
        "-i", palettePath, "-lavfi", "paletteuse=dither=sierra2_4a:diff_mode=rectangle", "-loop", "0", gifPath,
      ]);

      completed += 1;
      console.log(`[${completed}/${total}] ${episode.id}/${baseName} -> MP4 + GIF`);
    }
  }

  await browser.close();
  if (!onlyEpisode) {
    fs.writeFileSync(
      path.join(outputRoot, "export-summary.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), width: 925, height: figureHeight, fps: manifest.fps, episodes }, null, 2),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
