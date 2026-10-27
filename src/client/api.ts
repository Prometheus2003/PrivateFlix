export class OwnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function ownerApi(
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal ?? AbortSignal.timeout(20000),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "The request failed. Please try again.";
    throw new OwnerApiError(message, response.status);
  }
  return body;
}
export const ownerJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
