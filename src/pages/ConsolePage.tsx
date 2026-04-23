import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RFB from "@novnc/novnc";
import { useAuth } from "../auth/TeamsAuthProvider";
import { useBridgeApi } from "../api/bridge";

export function ConsolePage() {
  const { vmid } = useParams<{ vmid: string }>();
  const { accessToken } = useAuth();
  const api = useBridgeApi();
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting"
  );
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    if (!vmid || !accessToken || !canvasRef.current) return;

    let cancelled = false;
    let rfb: RFB | null = null;

    (async () => {
      try {
        // Single-use Session-Key + VNC-Password vom Bridge holen
        const numVmid = Number(vmid);
        const { sessionKey, password } = await api.vncSession(numVmid);
        if (cancelled || !canvasRef.current) return;

        const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = `${wsProto}://${window.location.host}/ws/vnc/${numVmid}?session=${encodeURIComponent(sessionKey)}`;

        rfb = new RFB(canvasRef.current, wsUrl, {
          wsProtocols: ["binary"],
          credentials: { password },
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "#000";
        rfb.viewOnly = false;

        rfb.addEventListener("connect", () => setStatus("connected"));
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

  function sendCtrlAltDel() {
    rfbRef.current?.sendCtrlAltDel();
  }

  return (
    <section className="page console-page">
      <header className="page-header">
        <h2>VM-Console (VMID {vmid})</h2>
        <div className="console-toolbar">
          <span className={`badge badge-${status}`}>{status}</span>
          {detail && <span className="console-detail">{detail}</span>}
          <button onClick={sendCtrlAltDel} disabled={status !== "connected"}>
            Ctrl+Alt+Del
          </button>
          <Link to="/my-vms">
            <button>Zurueck</button>
          </Link>
        </div>
      </header>

      <div className="console-canvas-wrap">
        <div className="console-canvas" ref={canvasRef} />
      </div>

      {status === "error" && (
        <div className="card error">
          <strong>Verbindung fehlgeschlagen.</strong>
          <p>
            Moegliche Ursachen: VM laeuft nicht, VNC-Proxy-Aufruf gegen Proxmox
            verweigert, oder die Bridge konnte den WebSocket nicht oeffnen.
            Pruefe im Bridge-Log nach <code>[bridge] upstream vnc</code> oder
            <code> [bridge] /ws/vnc auth failed</code>.
          </p>
        </div>
      )}
    </section>
  );
}
