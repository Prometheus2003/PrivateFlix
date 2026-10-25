import { describe, it, expect } from "vitest";
import { parseProbe, runMediaTool } from "@/lib/media/processor-tools";
const stream = {
  index: 0,
  codec_type: "video",
  codec_name: "png",
  width: 320,
  height: 240,
};
describe("bounded media tools", () => {
  it("extracts image and video metadata", () => {
    expect(parseProbe({ streams: [stream] }, "IMAGE")).toMatchObject({
      width: 320,
      height: 240,
      duration: null,
    });
    expect(
      parseProbe(
        {
          streams: [{ ...stream, codec_name: "h264" }],
          format: { duration: "2.5", bit_rate: "200000" },
        },
        "VIDEO",
      ),
    ).toMatchObject({ duration: 2.5, bitrate: 200000 });
  });
  it("rejects oversized images, attached covers and invalid durations", () => {
    expect(() =>
      parseProbe(
        { streams: [{ ...stream, width: 16384, height: 16384 }] },
        "IMAGE",
      ),
    ).toThrow();
    expect(() =>
      parseProbe(
        { streams: [{ ...stream, disposition: { attached_pic: 1 } }] },
        "IMAGE",
      ),
    ).toThrow();
    for (const duration of ["NaN", "Infinity", "-1", "9999999"])
      expect(() =>
        parseProbe({ streams: [stream], format: { duration } }, "VIDEO"),
      ).toThrow();
  });
  it("does not pass application credentials to child processes", async () => {
    process.env.PRIVATEFLIX_CHILD_SECRET = "test-only";
    try {
      expect(
        await runMediaTool(
          process.execPath,
          [
            "-e",
            "process.stdout.write(String(process.env.PRIVATEFLIX_CHILD_SECRET))",
          ],
          AbortSignal.timeout(5000),
        ),
      ).toBe("undefined");
    } finally {
      delete process.env.PRIVATEFLIX_CHILD_SECRET;
    }
  });
  it("terminates tools on timeout", async () => {
    await expect(
      runMediaTool(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        AbortSignal.timeout(100),
      ),
    ).rejects.toThrow();
  });
  it("caps stdout and stderr", async () => {
    for (const channel of ["stdout", "stderr"])
      await expect(
        runMediaTool(
          process.execPath,
          ["-e", `process.${channel}.write('x'.repeat(2*1024*1024))`],
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow();
  });
});
