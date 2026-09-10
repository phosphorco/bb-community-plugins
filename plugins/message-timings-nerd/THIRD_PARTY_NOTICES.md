# Inspiration

The user-message timestamp feature was inspired by
[bighitbiker3/bb-plugin-message-timestamps](https://github.com/bighitbiker3/bb-plugin-message-timestamps).

This plugin is an independent Phosphor implementation. It does not vendor that
repository's code or assets. Its turn-completion, inter-message timing, native
pane integration, scheduling, and tests are implemented here.

Runtime dependency: Zod, MIT licensed. BB supplies the shared React runtime and
plugin SDK frontend bindings; neither is bundled as a second runtime.
