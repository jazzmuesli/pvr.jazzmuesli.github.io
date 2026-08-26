// Client-side conversation logger. Each browser session gets a stable
// `sessionId`; every user turn and bot turn is sent to the dev-server `/log`
// endpoint, which appends it to `logs/<sessionId>.log`. This leaves a trail of
// real conversations that can be reviewed to improve the advisor over time.
//
// Logging is best-effort: any failure is swallowed so it never breaks the UI.

export interface LogTurn {
  role: "user" | "bot";
  text: string;
  intent?: string;
  stage?: string;
  scenario?: unknown;
}

export interface Logger {
  sessionId: string;
  record(turn: LogTurn): void;
}

function makeSessionId(): string {
  let id = "";
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      id = crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "");
    }
  } catch {
    /* ignore */
  }
  if (!id) id = String(Math.random()).replace(/[^a-zA-Z0-9]/g, "") + Date.now().toString(36);
  return id.slice(0, 32);
}

export function createLogger(): Logger {
  const sessionId = makeSessionId();
  return {
    sessionId,
    record(turn: LogTurn) {
      try {
        const payload = JSON.stringify({ sessionId, entry: turn });
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          navigator.sendBeacon("/log", new Blob([payload], { type: "application/json" }));
        } else if (typeof fetch !== "undefined") {
          fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }).catch(
            () => {},
          );
        }
      } catch {
        /* never break the UI */
      }
    },
  };
}
