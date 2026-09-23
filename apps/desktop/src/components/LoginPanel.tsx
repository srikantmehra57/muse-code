import { useState } from "react";
import { openUrl } from "../lib/bridge";
import { useAppStore } from "../lib/store";

/**
 * In-app `muse login` device-code flow, shared by Onboarding and Settings → Account.
 * The bridge spawns the CLI and reports the URL + code; approval arrives as a bridge event.
 */
export function LoginPanel() {
  const loginPrompt = useAppStore((state) => state.loginPrompt);
  const loginBusy = useAppStore((state) => state.loginBusy);
  const loginError = useAppStore((state) => state.loginError);
  const startLogin = useAppStore((state) => state.startLogin);
  const cancelLogin = useAppStore((state) => state.cancelLogin);
  const [openError, setOpenError] = useState("");
  if (!loginPrompt) {
    return <div className="login-prompt">
      <p>Sign in with your Meta account — no terminal needed. Muse shows a code to approve in your browser.</p>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="primary" disabled={loginBusy} onClick={() => void startLogin()}>{loginBusy ? "Waiting for Muse…" : "Sign in with Meta"}</button>
      </div>
      {loginError ? <p role="alert">{loginError}</p> : null}
    </div>;
  }
  return <div className="login-prompt" role="status" aria-live="polite">
    <p>Open this page, then confirm the code matches:</p>
    <p className="login-code" aria-label={`Sign-in code ${loginPrompt.code}`}>{loginPrompt.code}</p>
    <div className="row" style={{ justifyContent: "flex-start" }}>
      <button type="button" className="primary" onClick={() => { setOpenError(""); void openUrl(loginPrompt.url).catch((cause) => setOpenError(String(cause))); }}>Open browser</button>
      <button type="button" className="chip" onClick={() => void cancelLogin()}>Cancel sign-in</button>
    </div>
    <p className="muted">Waiting for approval… this can take a minute.</p>
    {openError ? <p role="alert">{openError}</p> : null}
  </div>;
}
