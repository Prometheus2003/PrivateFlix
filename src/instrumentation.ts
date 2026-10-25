export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("./lib/validation/env");
    try {
      getEnv();
      const { startUploadMaintenance } = await import("./lib/media/cleanup");
      startUploadMaintenance();
    } catch (error) {
      // Next may leave its listener alive after an instrumentation exception.
      // Terminate instead of leaving a misconfigured instance serving errors.
      console.error(
        error instanceof Error
          ? error.message
          : "Invalid environment configuration",
      );
      process.exit(1);
    }
  }
}
