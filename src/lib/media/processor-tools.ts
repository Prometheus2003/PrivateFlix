import { spawn } from "node:child_process";
import { z } from "zod";
const streamSchema = z.object({
  index: z.number().int().min(0).max(127),
  codec_type: z.string(),
  codec_name: z.string().max(50),
  width: z.number().int().positive().max(16384).optional(),
  height: z.number().int().positive().max(16384).optional(),
  duration: z.string().max(50).optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
});
const probeSchema = z.object({
  streams: z.array(streamSchema).max(128),
  format: z
    .object({
      duration: z.string().max(50).optional(),
      bit_rate: z.string().max(50).optional(),
    })
    .optional(),
});
export function parseProbe(value: unknown, type: "IMAGE" | "VIDEO") {
  const probe = probeSchema.parse(value);
  const video = probe.streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  if (
    !video?.width ||
    !video.height ||
    video.width * video.height > 100_000_000
  )
    throw new Error("Unsupported media dimensions");
  const duration = Number(probe.format?.duration ?? video.duration);
  if (
    type === "VIDEO" &&
    (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400)
  )
    throw new Error("Invalid video duration");
  if (
    type === "IMAGE" &&
    !["png", "mjpeg", "webp", "gif", "hevc", "av1"].includes(video.codec_name)
  )
    throw new Error("Unsupported image codec");
  const bitrate = Number(probe.format?.bit_rate);
  return {
    streamIndex: video.index,
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    duration: type === "VIDEO" ? duration : null,
    bitrate:
      Number.isSafeInteger(bitrate) && bitrate > 0 && bitrate <= 2147483647
        ? bitrate
        : null,
  };
}
export function runMediaTool(
  binary: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        LANG: "C",
        AV_LOG_FORCE_NOCOLOR: "1",
      },
    });
    const chunks: Buffer[] = [];
    let output = 0,
      errors = 0,
      failed = false;
    const kill = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.length;
      if (output > 1024 * 1024) kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.length;
      if (errors > 65536) kill();
    });
    child.once("error", () => {
      signal.removeEventListener("abort", kill);
      reject(new Error("Media tool could not start"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted || failed || code !== 0)
        reject(new Error("Media tool failed or exceeded its limits"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal.aborted) kill();
  });
}
// Exclude URL/playlist/concat demuxers and network protocols; input paths are generated locally.
const inputOptions = [
  "-v",
  "error",
  "-max_alloc",
  "67108864",
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,image2,png_pipe,jpeg_pipe,webp_pipe,gif",
  "-probesize",
  "10485760",
  "-analyzeduration",
  "10000000",
  "-threads",
  "1",
];
export async function probeMedia(
  input: string,
  type: "IMAGE" | "VIDEO",
  signal: AbortSignal,
) {
  const result = await runMediaTool(
    "ffprobe",
    [
      ...inputOptions,
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration,bit_rate",
      "-of",
      "json",
      input,
    ],
    signal,
  );
  return parseProbe(JSON.parse(result), type);
}
export async function createThumbnail(
  input: string,
  output: string,
  streamIndex: number,
  signal: AbortSignal,
) {
  await runMediaTool(
    "ffmpeg",
    [
      "-nostdin",
      ...inputOptions,
      "-i",
      input,
      "-map",
      "0:" + streamIndex,
      "-an",
      "-sn",
      "-dn",
      "-frames:v",
      "1",
      "-vf",
      "scale=640:640:force_original_aspect_ratio=decrease",
      "-filter_threads",
      "1",
      "-threads",
      "1",
      "-map_metadata",
      "-1",
      "-c:v",
      "mjpeg",
      "-q:v",
      "4",
      "-f",
      "image2",
      "-update",
      "1",
      "-y",
      output,
    ],
    signal,
  );
}
