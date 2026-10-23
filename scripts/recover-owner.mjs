import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import nextEnv from "@next/env";

async function hiddenInput(label) {
  if (!process.stdin.isTTY)
    throw new Error("Use --stdin for non-interactive recovery");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function finish(error) {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    function onData(chunk) {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 129) value += character;
      }
    }
    process.stdin.on("data", onData);
  });
}
async function readPassword() {
  if (process.argv.includes("--stdin")) {
    if (process.stdin.isTTY) throw new Error("--stdin requires a pipe");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 2048) throw new Error("Input too large");
    }
    const data = JSON.parse(input);
    if (
      typeof data.password !== "string" ||
      data.password !== data.confirmPassword
    )
      throw new Error("Passwords must match");
    return data.password;
  }
  const password = await hiddenInput("New owner password (hidden): ");
  if (password !== (await hiddenInput("Confirm password (hidden): ")))
    throw new Error("Passwords must match");
  return password;
}
let db;
try {
  nextEnv.loadEnvConfig(process.cwd());
  const password = await readPassword();
  if (
    password.length < 12 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^a-zA-Z0-9]/.test(password)
  )
    throw new Error(
      "Use 12–128 characters including upper/lowercase, a number and a symbol",
    );
  db = new PrismaClient({ log: [] });
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7253401)");
    const owners = await tx.user.findMany({ select: { id: true }, take: 2 });
    if (owners.length !== 1)
      throw new Error("Recovery requires exactly one existing owner");
    const userId = owners[0].id;
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.authThrottle.deleteMany();
    await tx.auditEvent.create({ data: { userId, action: "password_reset" } });
  });
  console.log("Owner password recovered. All sessions revoked.");
} catch {
  console.error(
    "Recovery failed. Check database access, owner existence and password requirements. No credentials were logged.",
  );
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
