import { useLayoutEffect, useRef } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
export default function SourceEditor({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (s: string) => void;
  label: string;
}) {
  const node = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    change = useRef(onChange),
    applyingSnapshot = useRef(false);
  change.current = onChange;
  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: node.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          markdown(),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.heading, color: "var(--primary)", fontWeight: "600" },
              { tag: tags.meta, color: "var(--muted-foreground)" },
              { tag: tags.monospace, fontFamily: "monospace" },
            ]),
          ),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applyingSnapshot.current)
              change.current(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              background: "transparent",
              color: "var(--foreground)",
            },
            ".cm-scroller": {
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "14px",
              overflow: "auto",
            },
            ".cm-content": { padding: "16px 8px" },
            ".cm-gutters": {
              background: "transparent",
              border: "none",
              color: "var(--muted-foreground)",
            },
            ".cm-activeLineGutter": { background: "var(--accent)" },
            ".cm-line": { padding: "0 6px" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [label]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      applyingSnapshot.current = true;
      try {
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: value },
        });
      } finally {
        applyingSnapshot.current = false;
      }
    }
  }, [value]);
  return <div className="mr-code" ref={node} />;
}
