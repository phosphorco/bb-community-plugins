/** Rendered under the declarative settings form on the plugin's detail page. */
export function AgentationSettingsSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        The toolbar mounts over the whole bb app, so it can annotate the shell
        and any plugin surface. Elements drawn by a plugin are attributed to
        that plugin automatically.
      </p>
      <p>
        New annotations enter a shared staging area. The thread prompt action
        shows how many are waiting; click it, add any instructions you want,
        and send the native prompt.
      </p>
      <p>
        Agents use the <code>agentation_mentions_*</code> tools to read, reply to, and
        resolve feedback. Resolving an annotation removes its marker from every
        open bb window.
      </p>
    </div>
  );
}
