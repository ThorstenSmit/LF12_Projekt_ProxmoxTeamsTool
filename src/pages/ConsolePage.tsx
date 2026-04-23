import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RFB from "@novnc/novnc";
import { useAuth } from "../auth/TeamsAuthProvider";
import { useBridgeApi } from "../api/bridge";

export function ConsolePage() {
  const { vmid } = useParams<{ vmid: string }>();
  const { accessToken } = useAuth();
  const api = useBridgeApi();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting"
  );
  const [detail, setDetail] = useState<string>("");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!vmid || !accessToken || !canvasRef.current) return;

    let cancelled = false;
    let rfb: RFB | null = null;

    (async () => {
      try {
        const numVmid = Number(vmid);
        const { sessionKey, password } = await api.vncSession(numVmid);
        if (cancelled || !canvasRef.current) return;

        const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = `${wsProto}://${window.location.host}/ws/vnc/${numVmid}?session=${encodeURIComponent(sessionKey)}`;

        rfb = new RFB(canvasRef.current, wsUrl, {
          wsProtocols: ["binary"],
          credentials: { password },
        });
        // Skaliert das VNC-Framebuffer ins Canvas-DIV. Keyboard + Mouse-Input
        // fokussiert noVNC automatisch beim Klick auf das Canvas.
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "#000";
        rfb.viewOnly = false;
        // focusOnClick ist Default true -- erstklick gibt Canvas Tastatur-Fokus.
        // Erste Tastenanschlaege also nach einem Klick ins Bild.

        rfb.addEventListener("connect", () => {
          setStatus("connected");
          // Sofort Fokus, damit keine Klicks zum tippen noetig sind.
          rfb?.focus();
        });
        rfb.addEventListener("disconnect", (ev: Event) => {
          setStatus("disconnected");
          const d = (ev as CustomEvent<{ reason?: string }>).detail;
          setDetail(d?.reason ?? "");
        });
        rfb.addEventListener("securityfailure", (ev: Event) => {
          setStatus("error");
          const d = (ev as CustomEvent<{ reason?: string }>).detail;
          setDetail(d?.reason ?? "security failure");
        });
        rfbRef.current = rfb;
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setDetail(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {}
        rfbRef.current = null;
      }
    };
  }, [vmid, accessToken, api]);

  // Browser-Fullscreen-Events spiegeln in den State, damit Layout + Button
  // konsistent sind, egal wer den Fullscreen verlaesst (ESC, F11, Button).
  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!wrapRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await wrapRef.current.requestFullscreen();
        // Nach Fullscreen-Switch nochmal fokussieren, sonst gehen die ersten
        // Tasten ins Leere.
        setTimeout(() => rfbRef.current?.focus(), 50);
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.error("fullscreen toggle failed:", e);
    }
  }, []);

  function sendCtrlAltDel() {
    rfbRef.current?.sendCtrlAltDel();
  }

  return (
    <section className={`page console-page ${fullscreen ? "fullscreen" : ""}`}>
      {!fullscreen && (
        <header className="page-header">
          <h2>VM-Console (VMID {vmid})</h2>
          <p className="page-subtitle">
            Klick ins Bild fuer Tastatur-Fokus. Vollbild gibt mehr Platz und
            bessere Maus-Capture.
          </p>
        </header>
      )}

      <div
        className={`console-canvas-wrap ${fullscreen ? "fullscreen" : ""}`}
        ref={wrapRef}
      >
        <div className="console-toolbar">
          <span className={`badge badge-${status}`}>{status}</span>
          {detail && <span className="console-detail">{detail}</span>}
          <button onClick={sendCtrlAltDel} disabled={status !== "connected"}>
            Ctrl+Alt+Del
          </button>
          <button onClick={toggleFullscreen} disabled={status !== "connected"}>
            {fullscreen ? "Vollbild verlassen (ESC)" : "Vollbild"}
          </button>
          {!fullscreen && (
            <Link to="/my-vms">
              <button>Zurueck</button>
            </Link>
          )}
        </div>
        <div className="console-canvas" ref={canvasRef} />
      </div>

      {status === "error" && !fullscreen && (
        <div className="card error">
          <strong>Verbindung fehlgeschlagen.</strong>
          <p>{detail}</p>
          <p>
            Pruefe im Bridge-Log nach <code>[bridge] upstream vnc</code> oder
            <code> [bridge] /ws/vnc</code>.
          </p>
        </div>
      )}
    </section>
  );
}
