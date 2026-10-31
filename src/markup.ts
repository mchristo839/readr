// Highlights, drawings, text boxes and notes as first-class, auto-saved document data.
// pdf.js owns the on-page editors; this keeps a saved copy per document and recreates the
// editors whenever the document is opened again.
import { AnnotationEditorParamsType, AnnotationEditorType } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "./viewer";
import type { PDFDocumentProxy } from "./pdf";
import { getNotes, saveNotes, type DocNotes, type StoredMark } from "./recent";

export type Mark = StoredMark;

const SAVED_TYPES: Record<string, Mark["type"]> = { highlight: "highlight", ink: "ink", freetext: "freetext" };

/* Minimal views of pdf.js internals used here (they're not part of its typed public API). */
interface Editor {
  id: string;
  pageIndex: number;
  div?: HTMLElement | null;
  deleted?: boolean;
  annotationElementId?: string | null;
  isClone?: boolean;
  x: number;
  y: number;
  pageDimensions: [number, number];
  comment: { text?: string; deleted?: boolean } | null;
  getPDFRect(): number[];
  getRectInCurrentCoords(rect: number[], pageHeight: number): number[];
  fixAndSetPosition(): void;
  isEmpty(): boolean;
  serialize(isForCopying?: boolean): Record<string, unknown> | null;
  remove(): void;
  constructor: { _type?: string };
  __folioMark?: string;
}
interface EditorLayer {
  div: HTMLElement;
  deserialize(data: Record<string, unknown>): Promise<Editor | null>;
  add(editor: Editor): void;
}
interface UIManager {
  getEditors(pageIndex: number): Iterable<Editor>;
  getEditor(id: string): Editor | undefined;
  getLayer(pageIndex: number): EditorLayer | undefined;
  highlightSelection(methodOfCreation?: string): void;
}

const toHex = (color: unknown) =>
  Array.isArray(color) && color.length >= 3
    ? "#" + color.slice(0, 3).map((c) => Math.round(Number(c)).toString(16).padStart(2, "0")).join("")
    : "#ffd84d";

const newId = () => crypto.randomUUID();

export interface MarkupState {
  marks: Mark[];
  note: string;
}

export class MarkupController {
  #bus: EventBus;
  #viewer: PDFViewer;
  #ui: UIManager | null = null;
  #docId: string | null = null;
  #persist = false;
  #note = "";
  /** Saved marks whose page hasn't rendered yet, keyed by page index. */
  #pending = new Map<number, Mark[]>();
  /** Last known record for every mark (text, note, created time survive re-serialization). */
  #known = new Map<string, Mark>();
  #restoring = new Set<number>();
  /** The most recent text selection in the document, used as the text of the next new highlight. */
  #lastSelection = { text: "", at: 0 };
  #syncTimer = 0;
  #saveTimer = 0;
  #listener: (state: MarkupState) => void;
  /** True while Marginalia itself switches pdf.js modes for a one-click highlight. */
  quickHighlighting = false;

  constructor(bus: EventBus, viewer: PDFViewer, listener: (state: MarkupState) => void) {
    this.#bus = bus;
    this.#viewer = viewer;
    this.#listener = listener;
    bus.on("annotationeditoruimanager", ({ uiManager }: { uiManager: UIManager }) => {
      this.#ui = uiManager;
    });
    // pdf.js asks the host app to enter highlight mode when highlighting a selection.
    bus.on("showannotationeditorui", ({ mode }: { mode: number }) => {
      this.#viewer.annotationEditorMode = { mode };
    });
    document.addEventListener("selectionchange", () => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
      const text = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, " ").trim() : "";
      if (text && anchor?.closest(".textLayer")) this.#lastSelection = { text, at: Date.now() };
    });
    bus.on("annotationeditorlayerrendered", ({ pageNumber }: { pageNumber: number }) => void this.#restorePage(pageNumber - 1));
    for (const name of ["annotationeditorstateschanged", "annotationeditormodechanged", "editingaction"]) {
      bus.on(name, () => this.scheduleSync());
    }
  }

  get state(): MarkupState {
    return { marks: this.#sorted(), note: this.#note };
  }

  /** Loads saved markup for a newly opened document. Password-protected documents aren't persisted. */
  async load(docId: string, persist: boolean) {
    // Save the outgoing document first (its editors are still live at this point).
    this.sync();
    this.flush();
    this.#docId = docId;
    this.#persist = persist;
    this.#pending.clear();
    this.#known.clear();
    this.#note = "";
    const saved = persist ? await getNotes(docId) : undefined;
    if (this.#docId !== docId) return;
    this.#note = saved?.note ?? "";
    for (const mark of saved?.marks ?? []) {
      this.#known.set(mark.id, mark);
      const list = this.#pending.get(mark.page) ?? [];
      list.push(mark);
      this.#pending.set(mark.page, list);
    }
    this.#emit();
    // Pages that rendered before the saved data arrived.
    for (const page of [...this.#pending.keys()]) if (this.#ui?.getLayer(page)) void this.#restorePage(page);
  }

  unload() {
    // Read the live editors first: an edit committed in place (retyping a text box, then Escape) fires no event
    // that schedules a sync, so it would otherwise be lost.
    this.sync();
    this.flush();
    this.#docId = null;
    this.#pending.clear();
    this.#known.clear();
    this.#note = "";
    this.#emit();
  }

  async #restorePage(page: number) {
    const marks = this.#pending.get(page);
    const layer = this.#ui?.getLayer(page);
    if (!marks?.length || !layer || this.#restoring.has(page)) return;
    this.#restoring.add(page);
    const docId = this.#docId;
    try {
      let added = false;
      // Marks pdf.js couldn't bring back stay pending, which keeps their saved records (and Notes entries) intact.
      const missed: Mark[] = [];
      for (const mark of marks) {
        // pdf.js only puts a text box's saved text on the page when the box is recreated as a copy; without it
        // the box comes back empty and the next sync drops it. isClone stops the copy being offset like a paste
        // (the same steps pdf.js takes when it duplicates a page).
        const textBox = mark.type === "freetext";
        const editor = await layer.deserialize({ ...mark.data, deleted: false, annotationElementId: null, isCopy: textBox }).catch(() => null);
        if (this.#docId !== docId) continue;
        if (!editor) {
          missed.push(mark);
          continue;
        }
        editor.__folioMark = mark.id;
        if (textBox) editor.isClone = true;
        layer.add(editor);
        // An empty editor would be thrown away by pdf.js (and its mark with it) at the next tool change.
        if (editor.isEmpty()) {
          editor.remove();
          missed.push(mark);
          continue;
        }
        if (textBox) this.#moveTo(editor, mark.data.rect);
        if (mark.note) this.#setEditorNote(editor, mark.note);
        added = true;
      }
      // pdf.js hides an editor layer that was empty when its page rendered, and saved marks arrive after that.
      if (added) layer.div.hidden = false;
      if (this.#docId === docId) {
        if (missed.length) this.#pending.set(page, missed);
        else this.#pending.delete(page);
      }
    } finally {
      this.#restoring.delete(page);
    }
    this.scheduleSync();
  }

  /** Puts a restored text box back on its saved rectangle: pdf.js nudges a new box by its font size when it's first drawn. */
  #moveTo(editor: Editor, rect: unknown) {
    if (!Array.isArray(rect)) return;
    try {
      const [pageWidth, pageHeight] = editor.pageDimensions;
      const [wantX, wantY] = editor.getRectInCurrentCoords(rect, pageHeight);
      const [haveX, haveY] = editor.getRectInCurrentCoords(editor.getPDFRect(), pageHeight);
      editor.x += (wantX - haveX) / pageWidth;
      editor.y += (wantY - haveY) / pageHeight;
      editor.fixAndSetPosition();
    } catch {
      /* the text is restored either way */
    }
  }

  #setEditorNote(editor: Editor, note: string) {
    try {
      // Stored on the pdf.js editor too, so saved copies of the PDF carry the note as a pop-up.
      (editor as unknown as { comment: string }).comment = note;
    } catch {
      /* the note still lives in Marginalia's own record */
    }
  }

  #liveEditors(): Editor[] {
    const ui = this.#ui;
    const count = this.#viewer.pagesCount;
    if (!ui || !count) return [];
    const editors: Editor[] = [];
    for (let page = 0; page < count; page++) {
      for (const editor of ui.getEditors(page)) {
        if (SAVED_TYPES[editor.constructor._type ?? ""] && !editor.annotationElementId && !editor.deleted) editors.push(editor);
      }
    }
    return editors;
  }

  scheduleSync() {
    window.clearTimeout(this.#syncTimer);
    this.#syncTimer = window.setTimeout(() => this.sync(), 250);
  }

  /** Reads every live editor back into records, then saves. Returns ids of newly seen marks. */
  sync(): string[] {
    window.clearTimeout(this.#syncTimer);
    if (!this.#docId) return [];
    const fresh: string[] = [];
    const live = new Map<string, Mark>();
    for (const editor of this.#liveEditors()) {
      if (editor.isEmpty()) {
        // A saved mark whose editor reads empty (a text box cleared but not yet committed) keeps its record until
        // the edit is committed. Removing a mark removes its editor, so deletes still work.
        const previous = editor.__folioMark ? this.#known.get(editor.__folioMark) : undefined;
        if (previous) live.set(previous.id, previous);
        continue;
      }
      let data: Record<string, unknown> | null = null;
      try { data = editor.serialize(false); } catch { data = null; }
      if (!data) continue;
      let selectedText = "";
      if (!editor.__folioMark) {
        editor.__folioMark = newId();
        fresh.push(editor.__folioMark);
        if (Date.now() - this.#lastSelection.at < 5000) selectedText = this.#lastSelection.text;
        this.#lastSelection = { text: "", at: 0 };
      }
      const previous = this.#known.get(editor.__folioMark);
      const type = SAVED_TYPES[editor.constructor._type!];
      const comment = editor.comment;
      const text = type === "highlight" ? previous?.text || selectedText
        : type === "freetext" ? String(data.value ?? "") : "";
      const mark: Mark = {
        id: editor.__folioMark,
        type,
        page: editor.pageIndex,
        text,
        note: comment && !comment.deleted ? comment.text ?? "" : previous?.note ?? "",
        color: toHex(data.color),
        createdAt: previous?.createdAt ?? Date.now(),
        data: { ...data, id: undefined, popupRef: undefined },
      };
      live.set(mark.id, mark);
    }
    // Marks on pages that haven't rendered yet are kept as saved.
    for (const marks of this.#pending.values()) for (const mark of marks) live.set(mark.id, mark);
    const changed = live.size !== this.#known.size
      || [...live.values()].some((mark) => JSON.stringify(mark) !== JSON.stringify(this.#known.get(mark.id)));
    this.#known = live;
    if (changed) {
      this.#emit();
      this.#scheduleSave();
    }
    return fresh;
  }

  #sorted() {
    return [...this.#known.values()].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      const ra = a.data.rect as number[] | undefined;
      const rb = b.data.rect as number[] | undefined;
      // PDF y grows upward: higher on the page first.
      return (rb?.[3] ?? 0) - (ra?.[3] ?? 0) || a.createdAt - b.createdAt;
    });
  }

  #emit() {
    this.#listener(this.state);
  }

  #scheduleSave() {
    if (!this.#persist) return;
    window.clearTimeout(this.#saveTimer);
    this.#saveTimer = window.setTimeout(() => this.flush(), 400);
  }

  flush() {
    window.clearTimeout(this.#saveTimer);
    if (!this.#persist || !this.#docId) return;
    const notes: DocNotes = { id: this.#docId, note: this.#note, marks: [...this.#known.values()], updatedAt: Date.now() };
    void saveNotes(notes);
  }

  /**
   * Saved marks on pages pdf.js hasn't drawn yet, serialized like their editors would be. pdf.js only recreates a
   * mark's editor (and adds it to its annotation storage) when the page renders, so saved copies and printouts
   * need these added to include every mark.
   */
  async unrenderedMarks(pdf: PDFDocumentProxy): Promise<Record<string, unknown>[]> {
    const marks: Record<string, unknown>[] = [];
    for (const [pageIndex, pending] of this.#pending) {
      const [, , pageRight] = (await pdf.getPage(pageIndex + 1)).view;
      for (const mark of pending) {
        const data: Record<string, unknown> = { ...mark.data, pageIndex, deleted: false };
        const top = (mark.data.rect as number[] | undefined)?.[3];
        // The pop-up pdf.js gives an editor's comment (see AnnotationEditor.addComment).
        if (mark.note && top !== undefined) data.popup = { contents: mark.note, deleted: false, rect: [pageRight + 1, top - 100, pageRight + 181, top] };
        marks.push(data);
      }
    }
    return marks;
  }

  /** Highlights the current text selection in one click. Resolves to the new mark's id. */
  async highlightSelection(color: string): Promise<string | null> {
    const ui = this.#ui;
    const selection = document.getSelection();
    if (!ui || !selection || selection.isCollapsed) return null;
    // A page's text can be selected before pdf.js has finished drawing the page, but its highlight layer only exists
    // afterwards, and pdf.js drops a highlight (and the selection) on a page without one. Wait for the layer.
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const page = Number((anchor?.closest(".page") as HTMLElement | null)?.dataset.pageNumber);
    for (let i = 0; i < 200 && page && !ui.getLayer(page - 1); i++) await new Promise((r) => setTimeout(r, 25));
    if (selection.isCollapsed) return null;
    this.sync();
    const before = new Set(this.#liveEditors().map((e) => e.id));
    this.#lastSelection = { text: selection.toString().replace(/\s+/g, " ").trim(), at: Date.now() };
    this.quickHighlighting = true;
    try {
      this.#bus.dispatch("switchannotationeditorparams", { source: null, type: AnnotationEditorParamsType.HIGHLIGHT_COLOR, value: color });
      ui.highlightSelection("floating_button");
      // pdf.js clears the selection when it goes ahead; if it's still there, pdf.js found nothing to highlight.
      if (!selection.isCollapsed) return null;
      // pdf.js switches into highlight mode, creates the editor, and we return to reading mode. The switch first
      // redraws the visible pages, which can take seconds on a busy computer, and returning to reading mode before
      // it finishes cancels it and loses the highlight, so give it plenty of time.
      let created: Editor | undefined;
      for (let i = 0; i < 400 && !created; i++) {
        await new Promise((r) => setTimeout(r, 25));
        created = this.#liveEditors().find((e) => !before.has(e.id) && !e.isEmpty());
      }
      // pdf.js focuses the new highlight. Leaving highlight mode with it focused moves focus to the current page's
      // highlight layer, and throws if that page hasn't drawn one yet, which leaves pdf.js stuck mid-switch and
      // every later highlight ignored. Nothing needs the focus, so drop it first.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(".annotationEditorLayer")) focused.blur();
      this.#viewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
      await new Promise((r) => setTimeout(r, 0));
      if (!created) return null;
      this.sync();
      return created.__folioMark ?? null;
    } finally {
      this.quickHighlighting = false;
    }
  }

  #editorFor(markId: string) {
    return this.#liveEditors().find((e) => e.__folioMark === markId);
  }

  /** The highlight under a screen point (pdf.js highlights don't take clicks while reading), with its screen box. */
  markAt(clientX: number, clientY: number): { id: string; rect: { left: number; top: number; right: number; bottom: number } } | null {
    for (const editor of this.#liveEditors()) {
      if (editor.constructor._type !== "highlight" || !editor.__folioMark) continue;
      const view = this.#viewer.getPageView(editor.pageIndex) as unknown as
        { div?: HTMLElement; viewport?: { convertToViewportPoint(x: number, y: number): number[] } } | undefined;
      const surface = view?.div?.querySelector(".canvasWrapper") ?? view?.div;
      if (!surface || !view?.viewport) continue;
      const box = surface.getBoundingClientRect();
      if (clientY < box.top || clientY > box.bottom || clientX < box.left || clientX > box.right) continue;
      const quads = (this.#known.get(editor.__folioMark)?.data.quadPoints ?? editor.serialize(false)?.quadPoints) as ArrayLike<number> | undefined;
      if (!quads) continue;
      const q = Array.from(quads);
      const hits: { left: number; top: number; right: number; bottom: number }[] = [];
      for (let i = 0; i + 7 < q.length; i += 8) {
        const corners = [0, 2, 4, 6].map((k) => view.viewport!.convertToViewportPoint(q[i + k], q[i + k + 1]));
        const xs = corners.map((c) => box.left + c[0]);
        const ys = corners.map((c) => box.top + c[1]);
        hits.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
      }
      if (hits.some((r) => clientX >= r.left - 2 && clientX <= r.right + 2 && clientY >= r.top - 2 && clientY <= r.bottom + 2)) {
        return {
          id: editor.__folioMark,
          rect: {
            left: Math.min(...hits.map((r) => r.left)), right: Math.max(...hits.map((r) => r.right)),
            top: Math.min(...hits.map((r) => r.top)), bottom: Math.max(...hits.map((r) => r.bottom)),
          },
        };
      }
    }
    return null;
  }

  recolor(markId: string, hex: string) {
    const editor = this.#editorFor(markId) as (Editor & { updateParams?: (type: number, value: string) => void }) | undefined;
    editor?.updateParams?.(AnnotationEditorParamsType.HIGHLIGHT_COLOR, hex);
    this.scheduleSync();
  }

  markForEditorId(editorId: string) {
    const editor = this.#ui?.getEditor(editorId);
    return editor?.__folioMark ?? null;
  }

  setNote(markId: string, note: string) {
    const editor = this.#editorFor(markId);
    if (editor) this.#setEditorNote(editor, note);
    const known = this.#known.get(markId);
    if (known) this.#known.set(markId, { ...known, note });
    for (const marks of this.#pending.values()) {
      const pending = marks.find((m) => m.id === markId);
      if (pending) pending.note = note;
    }
    this.#emit();
    this.#scheduleSave();
    if (editor) this.scheduleSync();
  }

  setDocNote(note: string) {
    this.#note = note;
    this.#emit();
    this.#scheduleSave();
  }

  remove(markId: string) {
    const editor = this.#editorFor(markId);
    if (editor) editor.remove();
    for (const [page, marks] of this.#pending) {
      const rest = marks.filter((m) => m.id !== markId);
      if (rest.length) this.#pending.set(page, rest);
      else this.#pending.delete(page);
    }
    this.#known.delete(markId);
    this.#emit();
    this.#scheduleSave();
  }

  /** Scrolls a mark into view and briefly pulses it. */
  reveal(markId: string) {
    const mark = this.#known.get(markId);
    if (!mark) return;
    const rect = mark.data.rect as number[] | undefined;
    this.#viewer.scrollPageIntoView({
      pageNumber: mark.page + 1,
      destArray: rect ? [null, { name: "XYZ" }, null, rect[3] + 48, null] : undefined,
    } as Parameters<PDFViewer["scrollPageIntoView"]>[0]);
    window.setTimeout(() => {
      const div = this.#editorFor(markId)?.div;
      if (!div) return;
      div.classList.remove("folio-pulse");
      void div.offsetWidth;
      div.classList.add("folio-pulse");
    }, 350);
  }
}
