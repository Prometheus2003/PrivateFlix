import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/lib/validation/env-schema";
const valid = {
  DATABASE_URL: "postgresql://owner:secret@localhost:5432/privateflix",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "a".repeat(32),
  S3_SECRET_KEY: "b".repeat(64),
  S3_BUCKET: "privateflix-media",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "c".repeat(128),
};
describe("runtime configuration", () => {
  it("treats explicitly disabled optional Drive credentials as absent while enforcing them for Drive uploads", () => {
    const disabled = {
      GOOGLE_DRIVE_CLIENT_ID: "",
      GOOGLE_DRIVE_CLIENT_SECRET: "",
      GOOGLE_DRIVE_REFRESH_TOKEN: "",
      GOOGLE_DRIVE_FOLDER_ID: "",
    };
    expect(
      parseEnv({ ...valid, ...disabled }).GOOGLE_DRIVE_REFRESH_TOKEN,
    ).toBeUndefined();
    expect(() =>
      parseEnv({ ...valid, ...disabled, STORAGE_PROVIDER: "google-drive" }),
    ).toThrow("GOOGLE_DRIVE_REFRESH_TOKEN");
  });
  it("loads development defaults and parses false correctly", () => {
    const result = parseEnv(valid);
    expect(result.ENABLE_TRANSCODING).toBe(false);
    expect(result.SESSION_IDLE_TIMEOUT).toBe(86400);
    expect(result.STORAGE_PROVIDER).toBe("s3");
  });
  it("requires complete Drive credentials before selecting it for uploads", () => {
    expect(() =>
      parseEnv({ ...valid, STORAGE_PROVIDER: "google-drive" }),
    ).toThrow("GOOGLE_DRIVE_REFRESH_TOKEN");
    expect(
      parseEnv({
        ...valid,
        STORAGE_PROVIDER: "google-drive",
        GOOGLE_DRIVE_CLIENT_ID: "client",
        GOOGLE_DRIVE_CLIENT_SECRET: "secret",
        GOOGLE_DRIVE_REFRESH_TOKEN: "refresh",
        GOOGLE_DRIVE_FOLDER_ID: "private-folder",
      }).STORAGE_PROVIDER,
    ).toBe("google-drive");
    expect(() =>
      parseEnv({
        ...valid,
        GOOGLE_DRIVE_FOLDER_ID: "folder/path?token=private",
      }),
    ).toThrow("GOOGLE_DRIVE_FOLDER_ID");
  });
  it.each([
    "DATABASE_URL",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "REDIS_URL",
    "SESSION_SECRET",
  ])("rejects missing %s", (key) => {
    expect(() => parseEnv({ ...valid, [key]: undefined })).toThrow(key);
  });
  it.each([0, -1, "oops", "Infinity", 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe limits: %s",
    (limit) => {
      expect(() => parseEnv({ ...valid, MAX_UPLOAD_SIZE: limit })).toThrow(
        "MAX_UPLOAD_SIZE",
      );
    },
  );
  it("rejects placeholders and never echoes secrets", () => {
    const sensitive = "REPLACE_WITH_SUPER_PRIVATE_VALUE";
    try {
      parseEnv({ ...valid, S3_SECRET_KEY: sensitive });
      throw new Error("unexpected success");
    } catch (error) {
      expect(String(error)).toContain("S3_SECRET_KEY");
      expect(String(error)).not.toContain(sensitive);
    }
  });
  it("requires HTTPS in production", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrow(
      "APP_URL",
    );
    expect(
      parseEnv({
        ...valid,
        NODE_ENV: "production",
        APP_URL: "https://vault.example",
      }).APP_URL,
    ).toBe("https://vault.example");
  });
  it.each([
    "https://vault.example/path",
    "https://user:secret@vault.example",
    "https://vault.example?x=1",
  ])("rejects non-origin app URL %s", (APP_URL) =>
    expect(() => parseEnv({ ...valid, APP_URL })).toThrow("APP_URL"),
  );
  it("enforces idle within absolute lifetime", () =>
    expect(() =>
      parseEnv({
        ...valid,
        SESSION_IDLE_TIMEOUT: 100,
        SESSION_ABSOLUTE_TIMEOUT: 50,
      }),
    ).toThrow("SESSION_IDLE_TIMEOUT"));
  it("rejects wrong URL protocols", () =>
    expect(() =>
      parseEnv({ ...valid, DATABASE_URL: "https://example.com" }),
    ).toThrow("DATABASE_URL"));
  it("rejects malformed URLs without disclosing values", () => {
    const value = "private credential in malformed url";
    expect(() => parseEnv({ ...valid, APP_URL: value })).toThrow("APP_URL");
    try {
      parseEnv({ ...valid, APP_URL: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
});
