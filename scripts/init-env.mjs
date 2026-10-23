import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const db = randomBytes(32).toString("hex");
const access = randomBytes(16).toString("hex");
const storage = randomBytes(32).toString("hex");
const redis = randomBytes(32).toString("hex");
const content = `# Local development only. Never commit this file.
POSTGRES_PASSWORD=${db}
DATABASE_URL=postgresql://privateflix:${db}@127.0.0.1:5432/privateflix?schema=public
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY=${access}
S3_SECRET_KEY=${storage}
S3_BUCKET=privateflix-media
S3_REGION=us-east-1
REDIS_PASSWORD=${redis}
REDIS_URL=redis://:${redis}@127.0.0.1:6379
SESSION_SECRET=${randomBytes(64).toString("hex")}
SETUP_TOKEN=${randomBytes(32).toString("hex")}
APP_URL=http://localhost:3000
APP_NAME=PrivateFlix
APP_ACCENT_COLOR="#8b5cf6"
ENABLE_TRANSCODING=false
`;
try {
  writeFileSync(new URL("../.env", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created .env with unique local credentials. Existing files are never overwritten.",
  );
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(".env already exists; left unchanged.");
    process.exitCode = 1;
  } else throw error;
}
