"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Settings, ShieldCheck, Monitor, Eye, EyeOff } from "lucide-react";
import { ownerApi, ownerJson, OwnerApiError } from "@/client/api";
import { preferencesSchema } from "@/lib/validation/preferences";
import { usePreferences } from "./preferences-provider";
import { Button } from "./ui/button";
const sessionSchema = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  expiresAt: z.string(),
  userAgent: z.string().nullable(),
});
const accountSchema = z.object({
  user: z.object({ username: z.string(), email: z.string() }),
});
const systemSchema = z.object({
  version: z.string(),
  database: z.string(),
  libraryItems: z.number(),
  libraryBytes: z.number(),
  failedMedia: z.number(),
  thumbnailGeneration: z.string(),
  transcoding: z.string(),
  backup: z.string(),
});
type Session = z.infer<typeof sessionSchema>;
export function AccountSettings({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const {
    preferences,
    setPreferences,
    loaded,
    error: preferencesError,
  } = usePreferences();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [account, setAccount] = useState<
    z.infer<typeof accountSchema>["user"] | null
  >(null);
  const [system, setSystem] = useState<z.infer<typeof systemSchema> | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [target, setTarget] = useState<Session | "all" | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const confirmation = useRef<HTMLDialogElement>(null);
  const passwordAlert = useRef<HTMLParagraphElement>(null);
  const operations = useRef(new Set<AbortController>());
  const preferenceForm = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const controllers = operations.current;
    return () => {
      active.current = false;
      for (const controller of controllers) controller.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20000),
    ]);
    void Promise.all([
      ownerApi("/api/auth/session", { signal }),
      ownerApi("/api/auth/sessions", { signal }),
      ownerApi("/api/system/status", { signal }),
    ])
      .then(([user, list, health]) => {
        const nextAccount = accountSchema.parse(user).user;
        const nextSessions = z
          .object({ sessions: z.array(sessionSchema) })
          .parse(list).sessions;
        const nextSystem = systemSchema.parse(health);
        if (!controller.signal.aborted) {
          setAccount(nextAccount);
          setSessions(nextSessions);
          setSystem(nextSystem);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else {
          setMessage(
            "Account details could not be loaded. Refresh settings to retry.",
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [revision, onUnauthorized]);
  useEffect(() => {
    if (!target) return;
    const opener = document.activeElement;
    const modal = confirmation.current;
    modal?.showModal();
    return () => {
      modal?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [target]);
  async function mutate(path: string, options: RequestInit) {
    const controller = new AbortController();
    operations.current.add(controller);
    try {
      return await ownerApi(path, {
        ...options,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]),
      });
    } finally {
      operations.current.delete(controller);
    }
  }
  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const next = preferencesSchema.parse({
      theme: fields.get("theme"),
      playbackSpeed: Number(fields.get("playbackSpeed")),
      autoplay: fields.get("autoplay") === "on",
    });
    setBusy(true);
    setMessage("");
    try {
      const result = z
        .object({ preferences: preferencesSchema })
        .parse(await mutate("/api/settings", ownerJson("PUT", next)));
      if (active.current) {
        setPreferences(result.preferences);
        setMessage("Preferences saved.");
      }
    } catch (failure) {
      if (active.current) {
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else
          setMessage(
            "Preferences could not be saved. Your previous settings are still in use.",
          );
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordBusy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const newPassword = String(fields.get("newPassword") ?? "");
    if (newPassword !== fields.get("confirmNewPassword")) {
      setPasswordError("The new passwords do not match.");
      requestAnimationFrame(() => passwordAlert.current?.focus());
      return;
    }
    setPasswordBusy(true);
    setPasswordError("");
    setPasswordMessage("");
    try {
      await mutate(
        "/api/auth/change-password",
        ownerJson("POST", {
          currentPassword: fields.get("currentPassword"),
          newPassword,
          confirmNewPassword: fields.get("confirmNewPassword"),
        }),
      );
      if (active.current) {
        form.reset();
        setReveal(false);
        setPasswordMessage(
          "Password changed. Other sessions have been signed out.",
        );
        setRevision((value) => value + 1);
      }
    } catch (failure) {
      if (active.current) {
        setPasswordError(
          failure instanceof Error
            ? failure.message
            : "Password could not be changed.",
        );
        requestAnimationFrame(() => passwordAlert.current?.focus());
      }
    } finally {
      if (active.current) setPasswordBusy(false);
    }
  }
  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setRevokeError("");
    try {
      await mutate(
        target === "all" ? "/api/auth/logout-all" : "/api/auth/sessions",
        ownerJson(target === "all" ? "POST" : "DELETE", {
          currentPassword: fields.get("currentPassword"),
          ...(target === "all" ? {} : { sessionId: target.id }),
        }),
      );
      if (active.current) {
        if (target === "all" || target.current) onUnauthorized();
        else {
          setTarget(null);
          setMessage("Session revoked.");
          setRevision((value) => value + 1);
        }
      }
    } catch (failure) {
      if (active.current)
        setRevokeError(
          failure instanceof Error
            ? failure.message
            : "Session could not be revoked.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      id="settings"
      className="workspace-panel"
      aria-labelledby="settings-title"
    >
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">MAKE YOURSELF AT HOME</p>
          <h2 id="settings-title">
            <Settings size={22} aria-hidden="true" /> Settings
          </h2>
          <p className="muted">
            Preferences, account security and system status.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRevision((value) => value + 1);
            setMessage("");
          }}
        >
          Refresh settings
        </Button>
      </div>
      <p role="status" className="notice" aria-label="Settings updates">
        {message}
      </p>
      <div className="settings-grid">
        <div className="settings-card">
          <h3>Playback and appearance</h3>
          <p className="muted">Saved privately for your account.</p>
          {preferencesError && <p role="alert">{preferencesError}</p>}
          {loaded ? (
            <form
              key={`${preferences.theme}-${preferences.playbackSpeed}-${preferences.autoplay}`}
              ref={preferenceForm}
              onSubmit={(event) => void savePreferences(event)}
              className="settings-form"
            >
              <label className="library-field">
                Theme
                <select
                  name="theme"
                  aria-label="Theme"
                  defaultValue={preferences.theme}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="library-field">
                Default playback speed
                <select
                  name="playbackSpeed"
                  aria-label="Default playback speed"
                  defaultValue={preferences.playbackSpeed}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                    <option value={speed} key={speed}>
                      {speed}×
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-check">
                <input
                  name="autoplay"
                  type="checkbox"
                  defaultChecked={preferences.autoplay}
                />{" "}
                Play automatically when opening a video
              </label>
              <p className="muted">
                Your browser may require a tap to begin playback. Saved videos
                offer a resume choice.
              </p>
              <p className="muted">
                Quality: original file. Additional qualities will appear when
                transcoding is available.
              </p>
              <Button disabled={busy} type="submit">
                {busy ? "Saving…" : "Save preferences"}
              </Button>
            </form>
          ) : (
            <div
              className="settings-skeleton"
              aria-label="Loading preferences"
            />
          )}
        </div>
        <div className="settings-card">
          <h3>
            <ShieldCheck size={19} aria-hidden="true" /> Account security
          </h3>
          {account && (
            <p className="muted break-anywhere">
              {account.username} · {account.email}
            </p>
          )}
          <form
            className="settings-form"
            onSubmit={(event) => void changePassword(event)}
          >
            <label className="library-field">
              Current password
              <input
                aria-label="Current password for password change"
                name="currentPassword"
                type={reveal ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            <label className="library-field">
              New password
              <input
                name="newPassword"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <label className="library-field">
              Confirm new password
              <input
                name="confirmNewPassword"
                type={reveal ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <Button
              variant="ghost"
              type="button"
              aria-pressed={reveal}
              onClick={() => setReveal((value) => !value)}
            >
              {reveal ? (
                <EyeOff size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
              {reveal ? "Hide passwords" : "Show passwords"}
            </Button>
            <p className="muted">
              Use 12–128 characters with upper and lowercase letters, a number
              and a symbol. Changing it signs out your other sessions.
            </p>
            {passwordError && (
              <p role="alert" tabIndex={-1} ref={passwordAlert}>
                {passwordError}
              </p>
            )}
            <p role="status">{passwordMessage}</p>
            <Button type="submit" disabled={passwordBusy}>
              {passwordBusy ? "Changing password…" : "Change password"}
            </Button>
          </form>
        </div>
      </div>
      <div className="settings-card mt-5">
        <div className="workspace-heading">
          <h3>
            <Monitor size={19} aria-hidden="true" /> Active sessions
          </h3>
          <Button
            variant="secondary"
            disabled={busy || !sessions.length}
            onClick={() => {
              setRevokeError("");
              setTarget("all");
            }}
          >
            Sign out all sessions
          </Button>
        </div>
        <p className="muted">
          Revoking a session stops its access. Confirm your password before
          making changes.
        </p>
        {loading ? (
          <div
            className="settings-skeleton"
            aria-label="Loading active sessions"
          />
        ) : (
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <div>
                  <strong>
                    {session.current ? "This session" : "Other session"}
                  </strong>
                  <p className="muted break-anywhere">
                    {session.userAgent || "Browser information unavailable"}
                  </p>
                  <small>
                    Active {new Date(session.lastActivityAt).toLocaleString()} ·
                    Expires {new Date(session.expiresAt).toLocaleString()}
                  </small>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setRevokeError("");
                    setTarget(session);
                  }}
                >
                  Revoke session
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="settings-card mt-5">
        <h3>System status</h3>
        {system ? (
          <dl className="system-grid">
            <div>
              <dt>Version</dt>
              <dd>{system.version}</dd>
            </div>
            <div>
              <dt>Database</dt>
              <dd>{system.database}</dd>
            </div>
            <div>
              <dt>Library</dt>
              <dd>
                {system.libraryItems} items ·{" "}
                {(system.libraryBytes / 1024 ** 3).toFixed(2)} GiB
              </dd>
            </div>
            <div>
              <dt>Media needing attention</dt>
              <dd>{system.failedMedia}</dd>
            </div>
            <div>
              <dt>Thumbnails</dt>
              <dd>Generated automatically</dd>
            </div>
            <div>
              <dt>Transcoding / HLS</dt>
              <dd>Not available yet</dd>
            </div>
            <div>
              <dt>Backups</dt>
              <dd>Not configured · Phase 8</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">Refresh settings to load system status.</p>
        )}
      </div>
      {target && (
        <dialog
          ref={confirmation}
          aria-labelledby="revoke-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setTarget(null);
          }}
        >
          <h2 id="revoke-title">
            {target === "all"
              ? "Sign out every session?"
              : "Revoke this session?"}
          </h2>
          <p>
            {target === "all" || target.current
              ? "You will also be signed out on this browser."
              : "This browser session will lose access to your library."}
          </p>
          <form
            className="settings-form"
            onSubmit={(event) => void revoke(event)}
          >
            <label className="library-field">
              Current password
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            <p role="alert">{revokeError}</p>
            <div className="dialog-actions">
              <Button
                variant="secondary"
                type="button"
                disabled={busy}
                onClick={() => setTarget(null)}
              >
                Keep session
              </Button>
              <Button variant="danger" type="submit" disabled={busy}>
                {busy ? "Revoking…" : "Confirm revocation"}
              </Button>
            </div>
          </form>
        </dialog>
      )}
    </section>
  );
}
