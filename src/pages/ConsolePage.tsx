import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RFB from "@novnc/novnc";
import Keyboard from "react-simple-keyboard";
import "react-simple-keyboard/build/css/index.css";
import { useAuth } from "../auth/authContext";
import { useBridgeApi } from "../api/bridge";
import { wsUrl } from "../config/runtime";
import { StatusBadge } from "../components/StatusBadge";
import { errMsg } from "../lib/errors";

// Mapping von simple-keyboard-Buttons auf X11 Keysym + DOM event.code, das
// noVNC bzw. Proxmox-VNC fuer den Tastenanschlag erwartet.
// Druckbare ASCII-Chars werden direkt aus charCode abgeleitet, nur die
// Sondertasten brauchen diese Tabelle.
const SK_KEYMAP: Record<string, { keysym: number; code: string }> = {
  "{escape}": { keysym: 0xff1b, code: "Escape" },
  "{tab}": { keysym: 0xff09, code: "Tab" },
  "{enter}": { keysym: 0xff0d, code: "Enter" },
  "{bksp}": { keysym: 0xff08, code: "Backspace" },
  "{backspace}": { keysym: 0xff08, code: "Backspace" },
  "{space}": { keysym: 0x20, code: "Space" },
  "{capslock}": { keysym: 0xffe5, code: "CapsLock" },
  "{lock}": { keysym: 0xffe5, code: "CapsLock" },
  "{shiftleft}": { keysym: 0xffe1, code: "ShiftLeft" },
  "{shiftright}": { keysym: 0xffe2, code: "ShiftRight" },
  "{controlleft}": { keysym: 0xffe3, code: "ControlLeft" },
  "{controlright}": { keysym: 0xffe4, code: "ControlRight" },
  "{altleft}": { keysym: 0xffe9, code: "AltLeft" },
  "{altright}": { keysym: 0xffea, code: "AltRight" },
  "{metaleft}": { keysym: 0xffeb, code: "MetaLeft" },
  "{metaright}": { keysym: 0xffec, code: "MetaRight" },
  "{arrowup}": { keysym: 0xff52, code: "ArrowUp" },
  "{arrowdown}": { keysym: 0xff54, code: "ArrowDown" },
  "{arrowleft}": { keysym: 0xff51, code: "ArrowLeft" },
  "{arrowright}": { keysym: 0xff53, code: "ArrowRight" },
  "{home}": { keysym: 0xff50, code: "Home" },
  "{end}": { keysym: 0xff57, code: "End" },
  "{pageup}": { keysym: 0xff55, code: "PageUp" },
  "{pagedown}": { keysym: 0xff56, code: "PageDown" },
  "{insert}": { keysym: 0xff63, code: "Insert" },
  "{delete}": { keysym: 0xffff, code: "Delete" },
  "{prtscn}": { keysym: 0xff61, code: "PrintScreen" },
  // F1..F12 dynamisch dazu:
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `{f${i + 1}}`,
      { keysym: 0xffbe + i, code: `F${i + 1}` },
    ])
  ),
};

// Layout deckt: F-Reihe, Zahlen, QWERTY, Modifier, Pfeile, Print.
const KB_LAYOUT = {
  default: [
    "{escape} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12} {prtscn}",
    "` 1 2 3 4 5 6 7 8 9 0 - = {bksp}",
    "{tab} q w e r t y u i o p [ ] \\",
    "{lock} a s d f g h j k l ; ' {enter}",
    "{shiftleft} z x c v b n m , . / {shiftright} {arrowup} {delete}",
    "{controlleft} {metaleft} {altleft} {space} {altright} {metaright} {arrowleft} {arrowdown} {arrowright}",
  ],
  shift: [
    "{escape} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12} {prtscn}",
    "~ ! @ # $ % ^ & * ( ) _ + {bksp}",
    "{tab} Q W E R T Y U I O P { } |",
    '{lock} A S D F G H J K L : " {enter}',
    "{shiftleft} Z X C V B N M < > ? {shiftright} {arrowup} {delete}",
    "{controlleft} {metaleft} {altleft} {space} {altright} {metaright} {arrowleft} {arrowdown} {arrowright}",
  ],
};

const KB_DISPLAY: Record<string, string> = {
  "{escape}": "Esc",
  "{tab}": "Tab",
  "{bksp}": "⌫",
  "{enter}": "Enter",
  "{lock}": "Caps",
  "{shiftleft}": "Shift",
  "{shiftright}": "Shift",
  "{controlleft}": "Ctrl",
  "{controlright}": "Ctrl",
  "{altleft}": "Alt",
  "{altright}": "Alt",
  "{metaleft}": "Win",
  "{metaright}": "Win",
  "{space}": " ",
  "{arrowup}": "↑",
  "{arrowdown}": "↓",
  "{arrowleft}": "←",
  "{arrowright}": "→",
  "{delete}": "Del",
  "{prtscn}": "PrtSc",
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`{f${i + 1}}`, `F${i + 1}`])
  ),
};

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
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [kbLayoutName, setKbLayoutName] = useState<"default" | "shift">("default");

  useEffect(() => {
    if (!vmid || !accessToken || !canvasRef.current) return;

    let cancelled = false;
    let rfb: RFB | null = null;

    (async () => {
      try {
        const numVmid = Number(vmid);
        const { sessionKey, password } = await api.vncSession(numVmid);
        if (cancelled || !canvasRef.current) return;

        // wsUrl() leitet die ws(s)://-URL aus der konfigurierten Bridge-Origin
        // ab (API_BASE_URL) bzw. faellt auf die aktuelle Seiten-Origin zurueck.
        const socketUrl = wsUrl(
          `/ws/vnc/${numVmid}?session=${encodeURIComponent(sessionKey)}`
        );

        rfb = new RFB(canvasRef.current, socketUrl, {
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
          setDetail(errMsg(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // bereits getrennt oder nie verbunden — ignorieren
        }
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

  // Klick auf der virtuellen Tastatur — wir mappen den simple-keyboard-Button
  // auf X11-Keysym + DOM-Code und schicken's an noVNC.
  function handleVirtKey(button: string) {
    const rfb = rfbRef.current;
    if (!rfb) return;

    // Shift toggelt das simple-keyboard-Layout (visuelle Capslock-Effekte).
    if (button === "{shiftleft}" || button === "{shiftright}") {
      setKbLayoutName((s) => (s === "default" ? "shift" : "default"));
    }

    const mapped = SK_KEYMAP[button];
    if (mapped) {
      rfb.sendKey(mapped.keysym, mapped.code);
    } else if (button.length === 1) {
      // Druckbares ASCII -- keysym entspricht direkt dem char code.
      const cc = button.charCodeAt(0);
      const upper = button.toUpperCase();
      const code = /^[a-zA-Z]$/.test(upper) ? `Key${upper}` : `Digit${button}`;
      rfb.sendKey(cc, code);
    }
    rfb.focus();
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
        <div className="console-toolbar icon-actions">
          <StatusBadge status={status} />
          {detail && <span className="console-detail">{detail}</span>}
          <button
            className="icon-button wide"
            aria-label="Ctrl+Alt+Del"
            title="Ctrl+Alt+Del an die VM senden"
            data-tooltip="Ctrl+Alt+Del senden"
            onClick={sendCtrlAltDel}
            disabled={status !== "connected"}
          >
            Ctrl+Alt+Del
          </button>
          <button
            className={`icon-button ${showKeyboard ? "active" : ""}`}
            aria-label="Virtuelle Tastatur"
            title="Virtuelle Tastatur (Esc, Win, F1-F12)"
            data-tooltip={showKeyboard ? "Tastatur ausblenden" : "Tastatur einblenden"}
            onClick={() => setShowKeyboard((s) => !s)}
            disabled={status !== "connected"}
          >
            ⌨
          </button>
          <button
            className="icon-button"
            aria-label={fullscreen ? "Vollbild verlassen" : "Vollbild"}
            title={fullscreen ? "Vollbild verlassen (ESC)" : "Vollbild"}
            data-tooltip={fullscreen ? "Vollbild verlassen (ESC)" : "Vollbild"}
            onClick={toggleFullscreen}
            disabled={status !== "connected"}
          >
            ⛶
          </button>
          {!fullscreen && (
            <Link to="/my-vms">
              <button
                className="icon-button"
                aria-label="Zurueck"
                title="Zurueck zur VM-Liste"
                data-tooltip="Zurueck zur VM-Liste"
              >
                ←
              </button>
            </Link>
          )}
        </div>
        <div className="console-canvas" ref={canvasRef} />
        {showKeyboard && (
          <div className="virt-kbd-wrap">
            <Keyboard
              theme="hg-theme-default hg-layout-default pttool-kbd"
              layout={KB_LAYOUT}
              layoutName={kbLayoutName}
              display={KB_DISPLAY}
              onKeyPress={handleVirtKey}
              physicalKeyboardHighlight={false}
              mergeDisplay={true}
              preventMouseDownDefault={true}
            />
          </div>
        )}
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
