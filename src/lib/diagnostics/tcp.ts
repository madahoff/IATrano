import { connect } from "node:net";

export type TcpProbeResult =
  | { ok: true; durationMs: number; address?: string }
  | { ok: false; durationMs: number; code: string; message: string };

export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<TcpProbeResult>;

/** Ouvre (puis referme aussitôt) une connexion TCP : résolution DNS + joignabilité du port. */
export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    const socket = connect({ host: host.replace(/^\[|\]$/g, ""), port });
    let settled = false;
    const done = (r: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true, durationMs: elapsed(), address: socket.remoteAddress }));
    socket.once("timeout", () => done({ ok: false, durationMs: elapsed(), code: "ETIMEDOUT", message: `aucune réponse en ${timeoutMs} ms` }));
    socket.once("error", (err: NodeJS.ErrnoException) => done({ ok: false, durationMs: elapsed(), code: err.code ?? "UNKNOWN", message: err.message }));
  });
