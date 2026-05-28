import { useEffect } from "react";
import type { VmDTO } from "../api/bridge";

// Polling-Kadenz: laufende VMs brauchen schnelle Updates (Live-Stats), im
// Leerlauf reicht ruhiger — aber wir pollen IMMER (auch bei nur gestoppten VMs
// oder leerer Liste), damit neu erstellte oder im Status geänderte VMs ohne
// manuellen Reload auftauchen.
export const REFRESH_INTERVAL_MS = 5000; // läuft was / Klon ausstehend
export const IDLE_REFRESH_INTERVAL_MS = 10000; // alles gestoppt

// Pollt `refresh` periodisch, solange der Consumer gemountet ist.
//   - mind. eine laufende VM ODER `opts.eager` (z.B. ein frisch erstellter Klon
//     ist noch nicht sichtbar) -> schnelles Intervall.
//   - sonst -> ruhigeres Intervall, aber weiterhin Polling.
export function useVmAutoRefresh(
  vms: VmDTO[] | null | undefined,
  refresh: () => void,
  opts: { eager?: boolean; activeMs?: number; idleMs?: number } = {}
): void {
  const anyRunning = (vms ?? []).some((v) => v.status === "running");
  const fast = anyRunning || !!opts.eager;
  const interval = fast
    ? opts.activeMs ?? REFRESH_INTERVAL_MS
    : opts.idleMs ?? IDLE_REFRESH_INTERVAL_MS;
  useEffect(() => {
    const id = setInterval(refresh, interval);
    return () => clearInterval(id);
  }, [refresh, interval]);
}
