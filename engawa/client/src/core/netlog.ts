// Connection / call-quality event log (issue #182).
//
// There is still no telemetry backend (invariant #2: the server stores
// nothing); this is a bounded in-memory log the user can export from the debug
// console and attach to a bug report, so "reconnect failed at 14:03" can be
// diagnosed after the fact. Writers are the network client (socket lifecycle),
// the App (reconnect scheduling, welcome), and both RTC transports (peer / ICE
// lifecycle, SFU ops). The ring buffer and export formatting are pure so they
// are unit-testable; the module-level singleton mirrors core/media-auth.ts.

export type NetLogEntry = {
  // Epoch ms. Wall-clock (not performance.now) so exported logs line up with
  // server logs and user reports.
  t: number;
  type: string;
  detail?: Record<string, unknown>;
};

// Lifecycle events (socket opens/closes, retries, peer/ICE transitions, SFU
// ops) are rare — a handful per incident — so 500 entries really does cover a
// full day. They get their own ring: the steady 5s quality samples would
// otherwise flush an incident out of a shared buffer in ~40 minutes, evicting
// exactly the entries a bug report needs.
export const NETLOG_CAPACITY = 500;
// The quality-sample ring: 720 samples ≈ the last hour of continuous calling.
export const NETLOG_QUALITY_CAPACITY = 720;

// Cadence of the App's call-quality sampling. 5s is fine-grained enough to
// catch a degrading link before the user gives up, while keeping getStats /
// log overhead negligible (the debug console polls independently at 1s).
export const QUALITY_SAMPLE_INTERVAL_MS = 5_000;

// Pure bounded log: push drops the oldest entry past `capacity`. Kept as a
// class (not module state) so tests can build their own instances.
export class BoundedLog<T> {
  private buf: T[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  push(item: T) {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  entries(): readonly T[] {
    return this.buf;
  }

  clear() {
    this.buf = [];
  }
}

const log = new BoundedLog<NetLogEntry>(NETLOG_CAPACITY);
const qualityLog = new BoundedLog<NetLogEntry>(NETLOG_QUALITY_CAPACITY);

// Record one event. `detail` must be JSON-serializable (it is exported
// verbatim); keep it small — counters and short strings, never whole objects
// like stats reports. High-frequency quality samples land in their own ring so
// they can never evict the rare lifecycle events (see the capacity comments).
export function logNet(type: string, detail?: Record<string, unknown>): void {
  const target = type === 'quality' ? qualityLog : log;
  target.push({ t: Date.now(), type, ...(detail ? { detail } : {}) });
}

// Both rings merged in timestamp order (equal stamps keep lifecycle first).
export function netLogEntries(): NetLogEntry[] {
  return [...log.entries(), ...qualityLog.entries()].sort((a, b) => a.t - b.t);
}

// Tests only.
export function resetNetLog(): void {
  log.clear();
  qualityLog.clear();
}

// Pure: the export payload for a given entry list (injectable meta for tests).
export function formatNetLogExport(
  entries: readonly NetLogEntry[],
  meta: { exportedAt: number; userAgent: string },
): string {
  return JSON.stringify(
    { exportedAt: new Date(meta.exportedAt).toISOString(), userAgent: meta.userAgent, entries },
    null,
    1,
  );
}

// The string copied to the clipboard by the debug console's log button.
export function exportNetLog(): string {
  return formatNetLogExport(log.entries(), {
    exportedAt: Date.now(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  });
}
