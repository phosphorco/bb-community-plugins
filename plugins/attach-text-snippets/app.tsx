import "./app.css";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useComposerView,
  useRpc,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "./rpc-contract.ts";
import { MAX_SNIPPET_BYTES } from "./snippet-model.ts";

type DialogController = {
  open(composer: PluginComposerApi): void;
};

const MENTION_PROVIDER_ID = "attach-text-snippets";
const controllers = new Map<string, Set<DialogController>>();

function scopeKey(threadId: string): string {
  return `thread:${threadId}`;
}

function registerController(key: string, controller: DialogController): () => void {
  const registered = controllers.get(key) ?? new Set<DialogController>();
  registered.add(controller);
  controllers.set(key, registered);
  return () => {
    registered.delete(controller);
    if (registered.size === 0) controllers.delete(key);
  };
}

function openSnippetDialog(threadId: string, composer: PluginComposerApi): void {
  controllers.get(scopeKey(threadId))?.values().next().value?.open(composer);
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function focusableElements(form: HTMLFormElement): HTMLElement[] {
  return Array.from(form.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
}

function SnippetDialogSurface({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const titleId = useId();
  const descriptionId = useId();
  const validationId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const [composer, setComposer] = useState<PluginComposerApi | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contentBytes = utf8Size(content);

  const clearDialog = useCallback((restoreFocus: boolean) => {
    const previousComposer = composer;
    setComposer(null);
    setTitle("");
    setContent("");
    setError(null);
    if (restoreFocus && previousComposer !== null) {
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        previousComposer.focus();
      });
    }
  }, [composer]);

  const close = useCallback(() => {
    if (busy) return;
    clearDialog(true);
  }, [busy, clearDialog]);

  useEffect(() => {
    const controller: DialogController = {
      open(nextComposer) {
        if (focusFrameRef.current !== null) {
          window.cancelAnimationFrame(focusFrameRef.current);
          focusFrameRef.current = null;
        }
        setTitle("");
        setContent("");
        setError(null);
        setComposer(nextComposer);
      },
    };
    const unregister = registerController(scopeKey(threadId), controller);
    return () => {
      unregister();
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    };
  }, [threadId]);

  useEffect(() => {
    if (composer === null) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composer]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (composer === null || busy) return;
    if (content.trim().length === 0) {
      setError("Paste some text before creating a snippet.");
      textareaRef.current?.focus();
      return;
    }
    if (contentBytes > MAX_SNIPPET_BYTES) {
      setError("Text snippets can be at most 1 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("createSnippet", { threadId, title, content });
      composer.insertMention({
        provider: MENTION_PROVIDER_ID,
        id: result.snippet.id,
        label: result.snippet.label,
      });
      clearDialog(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t create the text snippet.");
    } finally {
      setBusy(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(event.currentTarget);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  if (composer === null) return null;

  return createPortal(
    <div className="bb-attach-text-snippets-backdrop" role="presentation" onMouseDown={close}>
      <form
        className="bb-attach-text-snippets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <div>
            <h2 id={titleId}>Attach text snippet</h2>
            <p id={descriptionId}>Save long text as a durable file and add only its reference to the conversation.</p>
          </div>
          <button type="button" className="bb-attach-text-snippets-close" aria-label="Close" disabled={busy} onClick={close}>×</button>
        </header>

        <label>
          <span>Name <small>optional</small></span>
          <input
            type="text"
            value={title}
            maxLength={120}
            placeholder="Release notes, logs, source material…"
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="bb-attach-text-snippets-content-field">
          <span>Contents</span>
          <textarea
            ref={textareaRef}
            value={content}
            placeholder="Paste text here"
            spellCheck={false}
            disabled={busy}
            aria-invalid={contentBytes > MAX_SNIPPET_BYTES}
            aria-describedby={validationId}
            onChange={(event) => {
              setContent(event.target.value);
              setError(null);
            }}
          />
        </label>

        <footer>
          <span id={validationId} aria-live="polite" className={contentBytes > MAX_SNIPPET_BYTES
            ? "bb-attach-text-snippets-count bb-attach-text-snippets-count-error"
            : "bb-attach-text-snippets-count"}
          >
            {contentBytes.toLocaleString()} / {MAX_SNIPPET_BYTES.toLocaleString()} bytes
          </span>
          <div>
            <button type="button" className="bb-attach-text-snippets-secondary" disabled={busy} onClick={close}>Cancel</button>
            <button
              type="submit"
              className="bb-attach-text-snippets-primary"
              disabled={busy || content.trim().length === 0 || contentBytes > MAX_SNIPPET_BYTES}
            >
              {busy ? "Attaching…" : "Create & attach"}
            </button>
          </div>
        </footer>
        {error ? <p className="bb-attach-text-snippets-error" role="alert">{error}</p> : null}
        <p className="bb-attach-text-snippets-shortcut">⌘/Ctrl + Enter to attach</p>
      </form>
    </div>,
    document.body,
  );
}

const MemoSnippetDialogSurface = memo(SnippetDialogSurface);

function SnippetDialogHost() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <MemoSnippetDialogSurface threadId={view.scope.threadId} />;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "attach-text-snippets",
    scopes: ["thread"],
    banners: [{ id: "attach-text-snippets-dialog", chrome: "bare", component: SnippetDialogHost }],
    plusMenu: [{
      id: "attach-text-snippet",
      label: "Attach text snippet",
      icon: "FileText",
      description: "Paste text into a file and attach its reference",
      disabled: (view) => view.run.isSubmitting,
      run({ composer, view }) {
        if (view.scope.kind === "thread") openSnippetDialog(view.scope.threadId, composer);
      },
    }],
  });
});
