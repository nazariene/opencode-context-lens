import type { SessionRef } from "@opencode/plugin/gui";
import { LensRPC } from "./protocol.js";

interface Report {
  command: string;
  title: string;
  report: string;
  busy: boolean;
  failed: boolean;
  controller: AbortController;
}

export class DesktopCommands {
  private readonly run = `desktop_${crypto.randomUUID()}`;
  private readonly reports = new Map<string, Report>();
  private closed = false;

  constructor(private readonly changed: () => void) {}

  state(key: string): Readonly<Report> | undefined { return this.reports.get(key); }

  async execute(session: SessionRef, input = "help"): Promise<void> {
    const key = session.key, sessionID = session.id;
    if (this.closed || session.pending || this.reports.get(key)?.busy) return;
    // Capture the selected server once for this operation; resolve it anew on the next command.
    const client = session.server.client;
    const command = input.trim().replace(/^\/lens-prune(?:\s+|$)/, "") || "help";
    const entry: Report = { command, title: "", report: "", busy: true, failed: false, controller: new AbortController() };
    this.reports.delete(key);
    if (this.reports.size >= 8) {
      const oldest = this.reports.keys().next().value!;
      this.reports.get(oldest)!.controller.abort();
      this.reports.delete(oldest);
    }
    this.reports.set(key, entry);
    this.changed();
    const signal = entry.controller.signal;
    try {
      const source = await client.session.get({ sessionID }, { signal });
      signal.throwIfAborted();
      entry.title = source.title ?? "";
      const options = { location: source.location, signal }, rpc = client.rpc(LensRPC);
      const capabilities = await rpc.capabilities({}, options);
      signal.throwIfAborted();
      const output = await rpc.pruningCommand({ session_id: sessionID, run_id: this.run,
        instance_id: capabilities.instance_id, text: command }, options);
      signal.throwIfAborted();
      entry.report = output.report;
    } catch (error) {
      if (signal.aborted) return;
      entry.failed = true;
      entry.report = (error instanceof Error ? error.message : "Context Lens command failed.")
        + "\nCheck that Context Lens is enabled on this session's server and location. Inspect status before retrying an apply or restore.";
    } finally {
      entry.busy = false;
      if (!this.closed && this.reports.get(key) === entry) this.changed();
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.reports.values()) entry.controller.abort();
    this.reports.clear();
  }
}
