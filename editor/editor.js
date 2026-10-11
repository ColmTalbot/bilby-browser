// The code editor: CodeMirror 6 with Python support, bundled by esbuild into
// editor.bundle.js (npm run build:editor), which exposes `BilbyEditor`.
// Colours come from CSS variables in index.html, so the editor follows the
// page's light/dark theme.
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syn-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syn-number)" },
  { tag: [tags.comment, tags.lineComment, tags.docString], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.definition(tags.variableName)), tags.definition(tags.className)], color: "var(--syn-def)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-call)" },
  { tag: [tags.self, tags.standard(tags.variableName)], color: "var(--syn-builtin)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--code-bg)" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12.5px", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-error-line": { backgroundColor: "var(--error-line)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--fg)", border: "1px solid var(--border)" },
});

// Highlight for the line a traceback points at; cleared by any edit.
const setErrorLine = StateEffect.define();
const errorLine = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    if (tr.docChanged) return Decoration.none;
    for (const effect of tr.effects) {
      if (effect.is(setErrorLine)) {
        marks = effect.value == null
          ? Decoration.none
          : Decoration.set([Decoration.line({ class: "cm-error-line" }).range(effect.value)]);
      }
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function createEditor(parent, { onRun, label = "Python code" } = {}) {
  const extensions = [
    Prec.highest(keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => { onRun?.(); return true; } }])),
    basicSetup,
    keymap.of([indentWithTab]),
    python(),
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    syntaxHighlighting(highlightStyle),
    theme,
    errorLine,
    EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
  ];
  const state = (doc) => EditorState.create({ doc, extensions });
  const view = new EditorView({ state: state(""), parent });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    // a new example: fresh document and undo history
    load(text) {
      view.setState(state(text));
      view.scrollDOM.scrollTop = 0;
    },
    // back to the original text, as an edit that can be undone
    reset(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    // highlight a 1-based line number (null clears) and scroll to it
    markErrorLine(number) {
      if (number == null || number < 1 || number > view.state.doc.lines) {
        view.dispatch({ effects: setErrorLine.of(null) });
        return;
      }
      const line = view.state.doc.line(number);
      view.dispatch({
        effects: [setErrorLine.of(line.from), EditorView.scrollIntoView(line.from, { y: "center" })],
      });
    },
    focus: () => view.focus(),
  };
}
