import { Command, MenuItem, Panel, Plugin, Style, type MountedSession, type PanelTab } from "@opencode/plugin/gui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { DesktopCommands } from "./desktop-command.js";

export default Plugin.define({
  i18n: { en: { title: "Context Lens", open: "Open Context Lens", prune: "Prune conversation context" } },
  setup(ctx) {
    const [revision, setRevision] = createSignal(0);
    const commands = new DesktopCommands(() => setRevision((value) => value + 1));
    const state = (key: string) => { revision(); return commands.state(key); };
    const tab: PanelTab = { id: "main", get title() { return ctx.t("title"); }, closable: "compact", fallback: true };
    const open = (session: MountedSession) => ctx.layout.open(`${ctx.id}:main`, session);

    ctx.add(Command, (): Command => ({
      id: "open", title: ctx.t("open"), group: ctx.t("title"), section: "session",
      enabled: !!ctx.sessions.current() && !ctx.sessions.current()?.pending,
      run: () => { const session = ctx.sessions.current(); if (session && !session.pending) open(session); },
    }));
    ctx.add(Command, (): Command => ({
      id: "prune", title: ctx.t("prune"), group: ctx.t("title"), section: "session",
      slash: { name: "lens-prune", arguments: true },
      enabled: !!ctx.sessions.current() && !ctx.sessions.current()?.pending,
      run: async (input) => {
        const session = ctx.sessions.current();
        if (!session || session.pending) return;
        open(session);
        await commands.execute(session, input);
      },
    }));
    ctx.add(MenuItem, (): MenuItem | undefined => {
      const session = ctx.sessions.current();
      if (!session || session.pending) return;
      return { id: "open", menu: "session.panel", title: ctx.t("title"), keybind: `${ctx.id}.open`,
        opened: ctx.layout.state(`${ctx.id}:main`, session) !== "closed", run: () => open(session) };
    });
    ctx.add(Panel, {
      id: "main", region: "side",
      mobile: { get title() { return ctx.t("title"); }, order: 45, kind: "menu" },
      list: (input) => input.open.includes("main") ? [tab] : [],
      render: (props) => <LensPanel session={props.session} />,
    });
    ctx.add(Style, `
      .context-lens-panel { height:100%; overflow:auto; padding:16px; color:inherit; font-size:13px; }
      .context-lens-panel h2 { font-size:16px; font-weight:600; margin:0 0 8px; }
      .context-lens-panel p { margin:8px 0; overflow-wrap:anywhere; }
      .context-lens-panel .lens-muted { opacity:.7; font-size:12px; }
      .context-lens-panel .lens-buttons { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
      .context-lens-panel button, .context-lens-panel input, .context-lens-panel select {
        font:inherit; color:inherit; background:transparent; border:1px solid currentColor; border-radius:5px; padding:6px 9px;
      }
      .context-lens-panel button { cursor:pointer; }
      .context-lens-panel button:hover:not(:disabled) { background:color-mix(in srgb, currentColor 8%, transparent); }
      .context-lens-panel :disabled { opacity:.45; cursor:default; }
      .context-lens-panel input, .context-lens-panel select { display:block; width:100%; margin:5px 0 9px; }
      .context-lens-panel form { margin:14px 0; }
      .context-lens-panel label { display:block; }
      .context-lens-panel pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.6 monospace; margin:12px 0; }
      .context-lens-panel [role=alert] { border-left:3px solid currentColor; padding-left:10px; }
      .context-lens-panel summary { cursor:pointer; margin:12px 0; }
    `);

    function LensPanel(props: { session: MountedSession }) {
      const [input, setInput] = createSignal("");
      const [first, setFirst] = createSignal("");
      const [last, setLast] = createSignal("");
      const [action, setAction] = createSignal("range");
      createEffect(() => { props.session.key; setInput(""); setFirst(""); setLast(""); setAction("range"); });
      const current = () => state(props.session.key);
      const busy = () => !!current()?.busy || props.session.pending;
      const run = (text: string) => commands.execute(props.session, text);
      const shortcuts = [
        ["Help", "help"], ["Saved edits", "status"], ["Messages", "list messages"],
        ["Tool calls", "list tools"], ["Reasoning", "list reasoning"],
      ];
      const previews = [
        ["Prune tool outputs", "tools all --outputs"], ["Delete tool calls", "tools all"],
        ["Large calls ≥16 KiB", "large 16384"], ["Remove reasoning", "reasoning"],
      ];
      return <section class="context-lens-panel" aria-label="Context Lens">
        <h2>{ctx.t("title")}</h2>
        <p>{current()?.title || props.session.directory}</p>
        <p class="lens-muted">{props.session.server.name} [{props.session.id}]</p>
        <div class="lens-buttons"><For each={shortcuts}>{([label, command]) =>
          <button type="button" disabled={busy()} onClick={() => void run(command)}>{label}</button>
        }</For></div>
        <p>Preview context changes</p>
        <div class="lens-buttons"><For each={previews}>{([label, command]) =>
          <button type="button" disabled={busy()} onClick={() => void run(command)}>{label}</button>
        }</For></div>
        <details>
          <summary>Conversation range / summary</summary>
          <p class="lens-muted">Use IDs from Messages. Both boundaries are included. Summary generation uses the session model.</p>
          <form onSubmit={(event) => { event.preventDefault(); if (!busy()) void run(`${action()} ${first().trim()} ${last().trim()}`); }}>
            <label>Range action<select value={action()} onChange={(event) => setAction(event.currentTarget.value)}>
              <option value="range">Remove range</option>
              <option value="summarize brief">Summarize · brief</option>
              <option value="summarize full">Summarize · full</option>
            </select></label>
            <label>First message ID<input required value={first()} onInput={(event) => setFirst(event.currentTarget.value)} /></label>
            <label>Last message ID<input required value={last()} onInput={(event) => setLast(event.currentTarget.value)} /></label>
            <button type="submit" disabled={busy() || !first().trim() || !last().trim()}>Preview range</button>
          </form>
        </details>
        <form onSubmit={(event) => { event.preventDefault(); if (!busy()) void run(input()); }}>
          <label>Lens command<input maxLength={4096} value={input()} placeholder="tools read --outputs"
            onInput={(event) => setInput(event.currentTarget.value)} /></label>
          <button type="submit" disabled={busy()}>Run command</button>
        </form>
        <p class="lens-muted">Review the report, then run <code>apply PREVIEW_ID</code> shown below.
          Commands preview by default; <code>--apply</code> commits immediately. Use <code>restore GROUP_ID</code> or <code>restore all</code> to undo saved edits.</p>
        <Show when={current()} fallback={<p class="lens-muted">Choose an inventory or preview action. Reports stay in this panel, outside the conversation.</p>}>
          <p><code>/lens-prune {current()?.command}</code></p>
          <Show when={current()?.busy} fallback={
            <pre role={current()?.failed ? "alert" : undefined} aria-label="Command report">{current()?.report}</pre>
          }><p role="status">Running…</p></Show>
        </Show>
      </section>;
    }

    return () => commands.close();
  },
});
