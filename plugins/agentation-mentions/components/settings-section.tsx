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
        opens a popover where you can select feedback to attach or remove
        selected items from staging.
      </p>
      <p>
        Annotation context reaches an agent only after you attach its native
        mention or explicitly send it. Agents can then use the{" "}
        <code>agentation_mentions_*</code> tools to reply to and resolve it.
      </p>
    </div>
  );
}
