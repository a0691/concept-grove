import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(fileURLToPath(import.meta.url));
const temp = path.join(root, "render-temp");
const storyboardOnly = process.argv.includes("--storyboard");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const outputPath = path.join(root, "assets", "concept-grove-intro.mp4");
const frameRate = 60;
const subframes = 3;
const duration = 15;
const frameCount = frameRate * duration;

if (!fs.existsSync(chromePath)) throw new Error(`Chrome executable was not found: ${chromePath}`);
if (!fs.existsSync(path.join(root, "assets", "black-han-sans-v24.ttf"))) {
  throw new Error("The self-hosted Black Han Sans font is missing.");
}

fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--allow-file-access-from-files", "--disable-features=PaintHolding"]
});

try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  await page.goto(pathToFileURL(path.join(root, "intro.html")).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const fontReady = await page.evaluate(() => document.fonts.check('20px "Black Han Sans"'));
  if (!fontReady) throw new Error("Black Han Sans did not load in Chrome.");

  if (storyboardOnly) {
    const sheetDirectory = path.join(temp, "storyboard");
    fs.mkdirSync(sheetDirectory, { recursive: true });
    for (let beat = 0; beat < 30; beat += 1) {
      await page.evaluate((time) => window.seek(time), beat * 0.5);
      const frame = String(beat).padStart(2, "0");
      await page.screenshot({
        path: path.join(sheetDirectory, `beat-${frame}.png`),
        type: "png"
      });
    }
    console.log(`Rendered 30 storyboard frames to ${sheetDirectory}`);
    process.exitCode = 0;
  } else {
    const frameDirectory = path.join(temp, "frames");
    fs.mkdirSync(frameDirectory, { recursive: true });

    console.log("Rendering the 15-second OfflineAudioContext soundtrack...");
    const soundtrack = await page.evaluate(() => window.renderAudioWav());
    const soundtrackPath = path.join(temp, "soundtrack.wav");
    fs.writeFileSync(soundtrackPath, Buffer.from(soundtrack, "base64"));

    console.log(`Rendering ${frameCount * subframes} subframes at ${frameRate * subframes} fps...`);
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let subframe = 0; subframe < subframes; subframe += 1) {
        const time = (frame + subframe / subframes) / frameRate;
        await page.evaluate((timestamp) => window.seek(timestamp), time);
        const filename = `frame-${String(frame * subframes + subframe).padStart(5, "0")}.png`;
        await page.screenshot({
          path: path.join(frameDirectory, filename),
          type: "png"
        });
      }
      if ((frame + 1) % 120 === 0 || frame + 1 === frameCount) {
        console.log(`Rendered ${frame + 1} / ${frameCount} output frames`);
      }
    }

    const loopFrame = path.join(frameDirectory, "frame-00000.png");
    for (let subframe = 0; subframe < subframes; subframe += 1) {
      const startFrame = path.join(frameDirectory, `frame-${String(subframe).padStart(5, "0")}.png`);
      const endFrame = path.join(
        frameDirectory,
        `frame-${String((frameCount - 1) * subframes + subframe).padStart(5, "0")}.png`
      );
      if (subframe > 0) fs.copyFileSync(loopFrame, startFrame);
      fs.copyFileSync(loopFrame, endFrame);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const ffmpegArgs = [
      "-hide_banner",
      "-y",
      "-framerate", String(frameRate * subframes),
      "-start_number", "0",
      "-i", path.join(frameDirectory, "frame-%05d.png"),
      "-i", soundtrackPath,
      "-vf", "tmix=frames=3:weights='1 1 1',fps=60",
      "-frames:v", String(frameCount),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "0",
      "-force_key_frames", `expr:eq(n,0)+eq(n,${frameCount - 1})`,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath
    ];
    console.log("Blending subframes and muxing audio...");
    execFileSync(ffmpegPath, ffmpegArgs, { stdio: "inherit" });

    const probe = execFileSync(
      process.env.FFPROBE_PATH || ffmpegPath.replace(/ffmpeg(?:\.exe)?$/i, "ffprobe.exe"),
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-show_entries", "stream=codec_type,width,height,r_frame_rate,sample_rate",
        "-of", "json",
        outputPath
      ],
      { encoding: "utf8" }
    );
    const metadata = JSON.parse(probe);
    const seconds = Number(metadata.format?.duration);
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const audio = metadata.streams?.find((stream) => stream.codec_type === "audio");
    if (!video || video.width !== 1920 || video.height !== 1080) {
      throw new Error(`Unexpected video stream: ${JSON.stringify(video)}`);
    }
    if (!audio || !Number.isFinite(seconds) || seconds < 14.9 || seconds > 15.1) {
      throw new Error(`Unexpected output duration or audio stream: ${probe}`);
    }

    console.log(`Verified ${seconds}s ${video.width}x${video.height} ${video.r_frame_rate} video with ${audio.sample_rate}Hz audio.`);
    console.log(`Final MP4: ${outputPath}`);
    fs.rmSync(temp, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
