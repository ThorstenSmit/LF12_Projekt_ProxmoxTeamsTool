// Minimal type stubs for @novnc/novnc/core/rfb.js — the upstream package
// ships only JS plus JSDoc, no proper .d.ts.

declare module "@novnc/novnc" {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        wsProtocols?: string[];
        credentials?: { username?: string; password?: string; target?: string };
        shared?: boolean;
        repeaterID?: string;
      }
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    addEventListener(type: string, listener: (ev: Event) => void): void;
    removeEventListener(type: string, listener: (ev: Event) => void): void;
  }
}
