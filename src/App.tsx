import { useCallback, useEffect, useRef, useState } from "react";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  SpreadMode,
} from "./viewer";
import { AnnotationEditorParamsType, AnnotationEditorType } from "pdfjs-dist";
import { loadPdf, thumbnailDataUrl, type PDFDocumentProxy } from "./pdf";
import { contentKey, fileId, getRecent, MAX_RECENT_FILE_BYTES, saveRecent, updateLastPage } from "./recent";
import { activeDocument, FIT_SCALES, readView, setActiveDocument, writeView, type ReadingView } from "./session";
import { SearchResults } from "./SearchResults";
import { Icon, type IconName } from "./icons";
import { Welcome } from "./Welcome";
import { Sidebar, type SidebarTab } from "./Sidebar";
import { MarkupController, type Mark, type MarkupState } from "./markup";
import { HighlightMenu, NoteBox, SelectionPopover, useTextSelection, type SelectionInfo } from "./Selection";
import { NotesPanel } from "./NotesPanel";
import { imageRegions, trackPageImages } from "./nightImages";
import { ImageMenu, ImageViewer, type ImageTarget } from "./ImageViewer";
import { MoreMenu, type MoreItem } from "./MoreMenu";
import { keys } from "./platform";
import { AiPanel, type AiContext } from "./AiPanel";
import { ZoomMenu } from "./ZoomMenu";
import { SearchBar, type FindResult } from "./SearchBar";
import { AboutDialog, InfoDialog, OpenUrlDialog, PasswordDialog, ShortcutsDialog, parseWebUrl } from "./Dialogs";
import { SignatureDialog } from "./SignatureDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ChangelogDialog } from "./ChangelogDialog";
import { detectSignatureTargets, placeSignature, type SignatureTarget } from "./signatures";
import { keepDrawingPointer } from "./drawing";

type Tool = "select" | "highlight" | "ink" | "freetext";

const TOOL_MODES: Record<Tool, number> = {
  select: AnnotationEditorType.NONE,
  highlight: AnnotationEditorType.HIGHLIGHT,
  ink: AnnotationEditorType.INK,
  freetext: AnnotationEditorType.FREETEXT,
};

const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  { id: "select", icon: "cursor", label: "Select", key: "V" },
  { id: "ink", icon: "pen", label: "Draw", key: "D" },
  { id: "freetext", icon: "text", label: "Text", key: "T" },
];

const HIGHLIGHTS = [
  { name: "Yellow", hex: "#FFD84D" },
  { name: "Green", hex: "#5EDC9A" },
  { name: "Blue", hex: "#6CB8FF" },
  { name: "Pink", hex: "#FF8FC7" },
  { name: "Red", hex: "#FF5A4E" },
];

const INKS = [
  { name: "Black", hex: "#1C1B19" },
  { name: "Red", hex: "#E5533D" },
  { name: "Blue", hex: "#2F6FED" },
  { name: "Green", hex: "#1F9D55" },
  { name: "Purple", hex: "#8B5CF6" },
];

const PALETTE: Partial<Record<Tool, typeof INKS>> = { highlight: HIGHLIGHTS, ink: INKS, freetext: INKS };

const COLOR_PARAM: Partial<Record<Tool, number>> = {
  highlight: AnnotationEditorParamsType.HIGHLIGHT_COLOR,
  ink: AnnotationEditorParamsType.INK_COLOR,
  freetext: AnnotationEditorParamsType.FREETEXT_COLOR,
};

interface OpenDoc {
  id: string;
  /** Content-based key for highlights, notes, and AI conversations (two files can share a name and size). */
  key: string;
  name: string;
  /** The file's size; its bytes live in pdf.js's worker (pdf.getData()) rather than in a second copy here. */
  size: number;
  pdf: PDFDocumentProxy;
}

interface Pending {
  name: string;
  data: Uint8Array;
  error?: string;
}

// Blob copies the bytes itself, so no copy is made here. (The cast: BlobPart rules out views over a
// SharedArrayBuffer, which pdf.js never hands out, but its types don't say so.)
const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  const findRef = useRef<PDFFindController | null>(null);
  const restoreRef = useRef<ReadingView | null>(null);
  const restoringRef = useRef(false);
  const preferencesRef = useRef({ sidebar: true, spread: false });
  const openGeneration = useRef(0);
  const lastPageRef = useRef<number>(1);
  const docRef = useRef<OpenDoc | null>(null);
  const markupRef = useRef<MarkupController | null>(null);
  const persistRef = useRef(false);
  const dirtyRef = useRef(false);

  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("folio:sidebar") !== "0" && window.innerWidth > 760);
  const [searchOpen, setSearchOpen] = useState(false);
  const [find, setFind] = useState<FindResult>({ current: 0, total: 0, state: null });
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "light");
  const [spread, setSpread] = useState(() => localStorage.getItem("folio:spread") === "1");
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const [night, setNight] = useState(() => {
    try { return localStorage.getItem("folio:night") === "1"; }
    catch { return false; }
  });
  const [tool, setTool] = useState<Tool>("select");
  const [colors, setColors] = useState<Partial<Record<Tool, string>>>({
    highlight: HIGHLIGHTS[0].hex,
    ink: INKS[0].hex,
    freetext: INKS[0].hex,
  });
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const pageRef = useRef(1);
  pageRef.current = page;
  const [dirty, setDirty] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"info" | "shortcuts" | "about" | "url" | "settings" | "changelog" | null>(null);
  // A pasted or dropped link waits in Open from URL, so the user sees where it goes before Readr contacts it.
  const [linkDraft, setLinkDraft] = useState("");
  const openUrlDialog = (link = "") => { setLinkDraft(link); setDialog("url"); };
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [signatureTargets, setSignatureTargets] = useState<SignatureTarget[]>([]);
  const [signatureDismissed, setSignatureDismissed] = useState(false);
  const [markup, setMarkup] = useState<MarkupState>({ marks: [], note: "" });
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("pages");
  const [noteBox, setNoteBox] = useState<{ markId: string; anchor: { x: number; top: number; bottom: number }; quote: string; initial: string } | null>(null);
  const [stageWidth, setStageWidth] = useState(800);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState<SelectionInfo | null>(null);
  const [highlightMenu, setHighlightMenu] = useState<{ id: string; rect: { left: number; top: number; right: number; bottom: number } } | null>(null);
  const [imageMenu, setImageMenu] = useState<{ target: ImageTarget; x: number; y: number } | null>(null);
  const [imageView, setImageView] = useState<ImageTarget | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiContext, setAiContext] = useState<AiContext | null>(null);

  useEffect(() => {
    setSigning(false); setSignatureTargets([]); setSignatureDismissed(false);
    if (!doc) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void detectSignatureTargets(doc.pdf, page).then(targets => {
        if (!cancelled) setSignatureTargets(targets);
      }).catch(() => {});
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [doc, page]);

  docRef.current = doc;
  dirtyRef.current = dirty;
  preferencesRef.current = { sidebar, spread };

  /** Opening another document drops unsaved work (a placed signature, markup on a password-protected PDF), so ask first. */
  const mayReplaceDocument = () => !dirtyRef.current || confirm("You have unsaved annotations. Open another document anyway?");

  const toastTimer = useRef(0);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ── Viewer bootstrap ────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current!;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    const findController = new PDFFindController({ eventBus, linkService });
    findRef.current = findController;
    const viewer = new PDFViewer({
      container,
      viewer: innerRef.current!,
      eventBus,
      linkService,
      findController,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHTS.map((c) => `${c.name.toLowerCase()}=${c.hex}`).join(","),
      // Records where images are drawn (used to keep them true to color in night reading). The huge
      // minimum size turns off pdf.js's own right-click image targets, which Readr doesn't use.
      imagesRightClickMinSize: 1e9,
    });
    trackPageImages(eventBus);
    const stopDrawingPointer = keepDrawingPointer(container);
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    markupRef.current = new MarkupController(eventBus, viewer, setMarkup);
    busRef.current = eventBus;
    linkRef.current = linkService;

    eventBus.on("pagesinit", () => {
      restoringRef.current = true;
      const saved = restoreRef.current;
      viewer.spreadMode = (saved?.spread ?? spreadRef.current) ? SpreadMode.ODD : SpreadMode.NONE;
      viewer.pagesRotation = saved?.rotation ?? 0;
      viewer.currentScaleValue = saved?.scale ?? (window.innerWidth < 900 ? "page-width" : "auto");
      const restoredPage = Math.min(lastPageRef.current, viewer.pagesCount);
      viewer.currentPageNumber = restoredPage;
      if (saved && Number.isFinite(saved.top) && Number.isFinite(saved.left)) {
        viewer.scrollPageIntoView({ pageNumber: restoredPage, destArray: [null, { name: "XYZ" }, saved.left, saved.top, null] });
      }
      restoringRef.current = false;
    });
    eventBus.on("updateviewarea", ({ location }: { location: { pageNumber: number; top: number; left: number } }) => {
      const current = docRef.current;
      if (!current || restoringRef.current) return;
      writeView(current.id, { page: location.pageNumber, scale: viewer.currentScaleValue,
        rotation: viewer.pagesRotation, ...preferencesRef.current, top: location.top, left: location.left });
    });
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      pageRef.current = pageNumber;
      setPage(pageNumber);
      setPageInput(String(pageNumber));
    });
    eventBus.on("scalechanging", ({ scale }: { scale: number }) => setScale(scale));
    eventBus.on("rotationchanging", ({ pagesRotation }: { pagesRotation: number }) => setRotation(pagesRotation));
    eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
      setFind((f) => ({ ...f, ...matchesCount })),
    );
    eventBus.on(
      "updatefindcontrolstate",
      ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) =>
        setFind({ ...matchesCount, state }),
    );
    eventBus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
      // One-click highlights pass through highlight mode; the reader stays in Select.
      if (markupRef.current?.quickHighlighting) return;
      const entry = Object.entries(TOOL_MODES).find(([, m]) => m === mode);
      const next = entry ? (entry[0] as Tool) : "select";
      setTool(next);
      // Apply the remembered colour once the editor layer for this mode is live.
      const param = COLOR_PARAM[next];
      const value = colorsRef.current[next];
      if (param && value) eventBus.dispatch("switchannotationeditorparams", { source: null, type: param, value });
    });

    // Ctrl/⌘ + wheel or trackpad pinch zooms around the cursor.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!viewer.pdfDocument) return;
      viewer.updateScale({
        drawingDelay: 300,
        scaleFactor: Math.exp(-e.deltaY / 300),
        origin: [e.clientX, e.clientY],
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => { stopDrawingPointer(); container.removeEventListener("wheel", onWheel); };
  }, []);

  // ── Opening documents ───────────────────────────────────────────────
  const openBytes = useCallback(
    async (name: string, data: Uint8Array, password?: string) => {
      const generation = ++openGeneration.current;
      const viewer = viewerRef.current!;
      setLoading(true);
      setError(null);
      try {
        const pdf = await loadPdf(data, password).promise;
        const id = fileId(name, data.byteLength);
        const key = await contentKey(data);
        const existing = await getRecent(id);
        if (generation !== openGeneration.current) {
          void pdf.loadingTask.destroy();
          return;
        }
        const saved = readView(id);
        restoreRef.current = saved;
        lastPageRef.current = Math.min(saved?.page ?? existing?.lastPage ?? 1, pdf.numPages);
        if (saved) {
          setSidebar(saved.sidebar);
          setSpread(saved.spread);
          spreadRef.current = saved.spread;
          preferencesRef.current = { sidebar: saved.sidebar, spread: saved.spread };
        }

        const prev = docRef.current;
        const next: OpenDoc = { id, key, name, size: data.byteLength, pdf };
        docRef.current = next;
        // Password-protected documents aren't stored by Readr (same rule as Recent).
        persistRef.current = !password;
        void markupRef.current!.load(key, !password);
        setNoteBox(null);
        setPinned(null);
        setAiContext(null);
        viewer.setDocument(pdf);
        linkRef.current!.setDocument(pdf, null);
        prev?.pdf.loadingTask.destroy();

        // Markup is saved automatically; only documents Readr can't store count as having unsaved changes.
        (pdf.annotationStorage as { onSetModified: unknown }).onSetModified = () => { if (!persistRef.current) setDirty(true); };
        (pdf.annotationStorage as { onResetModified: unknown }).onResetModified = () => setDirty(false);

        setDoc(next);
        setNumPages(pdf.numPages);
        setPage(lastPageRef.current);
        setPageInput(String(lastPageRef.current));
        setRotation(0);
        setDirty(false);
        setTool("select");
        setPending(null);
        setSearchOpen(false);
        setFind({ current: 0, total: 0, state: null });
        document.title = `${name} — Readr`;

        setLoading(false);
        setActiveDocument(id);
        // Password-protected documents stay out of Recent: it would keep their bytes and a page-1
        // thumbnail unprotected on disk. Very large files are skipped too — see MAX_RECENT_FILE_BYTES.
        if (!password && data.byteLength <= MAX_RECENT_FILE_BYTES) void (async () => {
          const thumb = existing?.thumb ?? (await thumbnailDataUrl(pdf).catch(() => ""));
          if (generation !== openGeneration.current) return;
          await saveRecent({
            id,
            name,
            size: data.byteLength,
            pages: pdf.numPages,
            openedAt: Date.now(),
            lastPage: pageRef.current,
            thumb,
            data: pdfBlob(data),
          });
        })().catch(() => {});
      } catch (err) {
        if (generation !== openGeneration.current) return;
        const e = err as { name?: string; code?: number; message?: string };
        if (e?.name === "PasswordException") {
          setPending({ name, data, error: e.code === 2 ? "Incorrect password. Try again." : undefined });
        } else {
          setError(`Couldn't open “${name}”. ${e?.message ?? "The file may be damaged."}`);
        }
      } finally {
        if (generation === openGeneration.current) setLoading(false);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (file: File) => {
      // The desktop app converts Word documents; the PDF arrives like one opened from the file manager.
      if (window.folioDesktop && /\.docx?$/i.test(file.name)) {
        window.folioDesktop.openDocument(file).catch(() => setError(`Couldn't open “${file.name}”.`));
        return;
      }
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setError(`“${file.name}” isn't a PDF.`);
        return;
      }
      if (!mayReplaceDocument()) return;
      try {
        await openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch {
        setError(`Couldn't open “${file.name}”. The file may have been moved or deleted.`);
      }
    },
    [openBytes],
  );

  const pickFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = window.folioDesktop ? "application/pdf,.pdf,.doc,.docx" : "application/pdf,.pdf";
    input.onchange = () => { if (input.files?.[0]) void openFile(input.files[0]); };
    input.click();
  }, [openFile]);

  const openUrl = useCallback(
    async (url: string) => {
      if (!mayReplaceDocument()) return;
      const generation = ++openGeneration.current;
      const host = new URL(url).hostname;
      setLoading(true);
      setError(null);
      setToast(`Opening ${host}…`);
      try {
        let file: { name: string; data: Uint8Array } | null;
        if (window.folioDesktop) {
          file = await window.folioDesktop.fetchPdf(url);
        } else {
          // The browser edition can only read links whose server allows cross-origin requests.
          const res = await fetch(url).catch(() => {
            throw new Error(`Couldn't download from ${host}. The site may not allow it.`);
          });
          if (!res.ok) throw new Error(`The server responded with ${res.status}.`);
          const data = new Uint8Array(await res.arrayBuffer());
          // Same cap the desktop app applies to URL downloads.
          if (data.byteLength > 300 * 1024 * 1024) throw new Error("That PDF is larger than 300 MB.");
          const name = decodeURIComponent(new URL(res.url || url).pathname.split("/").filter(Boolean).pop() || host);
          file = { name: /\.pdf$/i.test(name) ? name : name + ".pdf", data };
        }
        if (generation !== openGeneration.current) return;
        setToast(null);
        if (!file) return setLoading(false);
        await openBytes(file.name, file.data);
      } catch (e: any) {
        if (generation !== openGeneration.current) return;
        setToast(null);
        setLoading(false);
        setError(`Couldn't open that link. ${e?.message ?? ""}`.trim());
      }
    },
    [openBytes],
  );

  const openSample = useCallback(async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
      await openBytes("Readr sample.pdf", new Uint8Array(await res.arrayBuffer()));
    } catch {
      setError("Couldn't open the sample document.");
    }
  }, [openBytes]);

  const closeDoc = useCallback(() => {
    if (dirty && !confirm("You have unsaved annotations. Close anyway?")) return;
    openGeneration.current++;
    setActiveDocument(null);
    markupRef.current!.unload();
    setNoteBox(null);
    setLoading(false);
    setPending(null);
    viewerRef.current!.setDocument(null as unknown as PDFDocumentProxy);
    linkRef.current!.setDocument(null, null);
    docRef.current?.pdf.loadingTask.destroy();
    docRef.current = null;
    setDoc(null);
    setDirty(false);
    setSearchOpen(false);
    setFocus(false);
    document.title = "Readr";
  }, [dirty]);

  // Remember where the reader left off.
  useEffect(() => {
    if (!doc) return;
    const saved = readView(doc.id);
    if (saved) writeView(doc.id, { ...saved, sidebar, spread });
  }, [doc, sidebar, spread]);
  useEffect(() => {
    if (!doc) return;
    const timer = window.setTimeout(() => void updateLastPage(doc.id, page), 600);
    return () => window.clearTimeout(timer);
  }, [doc, page]);

  // ── Actions ─────────────────────────────────────────────────────────
  const goTo = useCallback((n: number) => {
    const v = viewerRef.current!;
    if (!v.pdfDocument) return;
    v.currentPageNumber = Math.min(Math.max(1, n), v.pagesCount);
  }, []);
  const zoom = (steps: number) => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.updateScale({ steps, drawingDelay: 150, origin: undefined as unknown as number[] });
  };
  const setScaleValue = (value: string) => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.currentScaleValue = value;
  };
  const toggleSpread = () => {
    const v = viewerRef.current!;
    const next = !spread;
    setSpread(next);
    localStorage.setItem("folio:spread", next ? "1" : "0");
    if (!v.pdfDocument) return;
    const value = v.currentScaleValue;
    v.spreadMode = next ? SpreadMode.ODD : SpreadMode.NONE;
    // Re-fit so "fit width/page" accounts for two pages side by side.
    if (FIT_SCALES.includes(value)) v.currentScaleValue = value;
  };
  const rotate = () => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.pagesRotation = (v.pagesRotation + 90) % 360;
  };

  const chooseTool = (next: Tool) => {
    const v = viewerRef.current!;
    if (!v.pdfDocument) return;
    try {
      v.annotationEditorMode = { mode: TOOL_MODES[next] };
      setTool(next);
    } catch {
      flash("Annotations aren't supported for this document");
    }
  };
  const startSigning = () => { chooseTool("select"); setSigning(true); };

  const chooseColor = (hex: string) => {
    setColors((c) => ({ ...c, [tool]: hex }));
    const param = COLOR_PARAM[tool];
    if (param) busRef.current!.dispatch("switchannotationeditorparams", { source: null, type: param, value: hex });
  };

  // ── Highlights and notes ────────────────────────────────────────────
  const liveSelection = useTextSelection(container, !!doc && tool === "select" && !signing && !noteBox);
  // Typing in the popover's note field clears the page selection, so the popover keeps its own copy.
  const selection = pinned ?? liveSelection;
  const highlightColor = colors.highlight ?? HIGHLIGHTS[0].hex;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const quickHighlight = async (hex: string, note = "") => {
    const info = selection;
    if (!info) return;
    setColors((c) => ({ ...c, highlight: hex }));
    if (pinned) {
      const current = document.getSelection();
      current?.removeAllRanges();
      current?.addRange(info.range);
    }
    setPinned(null);
    const id = await markupRef.current!.highlightSelection(hex);
    if (!id) {
      flash("Couldn't highlight that selection");
      return;
    }
    if (note) markupRef.current!.setNote(id, note);
  };

  const dismissSelection = () => {
    setPinned(null);
    document.getSelection()?.removeAllRanges();
  };

  // Clicking an existing highlight offers recolor, note, Ask AI, and one-click removal.
  useEffect(() => {
    if (!container) return;
    const onDown = () => setPinned(null);
    const onClick = (e: MouseEvent) => {
      if (toolRef.current !== "select" || e.button !== 0) return;
      const current = document.getSelection();
      if (current && !current.isCollapsed) return;
      if ((e.target as HTMLElement).closest("a, .annotationCommentButton")) return;
      const hit = markupRef.current?.markAt(e.clientX, e.clientY);
      if (!hit) return setHighlightMenu(null);
      const stage = container.parentElement!.getBoundingClientRect();
      setHighlightMenu({ id: hit.id, rect: { left: hit.rect.left - stage.left, right: hit.rect.right - stage.left,
        top: hit.rect.top - stage.top, bottom: hit.rect.bottom - stage.top } });
    };
    const onScroll = () => setHighlightMenu(null);
    container.addEventListener("pointerdown", onDown);
    container.addEventListener("click", onClick);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("click", onClick);
      container.removeEventListener("scroll", onScroll);
    };
  }, [container]);
  useEffect(() => setHighlightMenu(null), [doc, scale, tool]);

  // Clicking an image offers "View larger" and, when it has a web address, "Open in browser".
  useEffect(() => {
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      setImageMenu(null);
      if (toolRef.current !== "select" || e.button !== 0) return;
      const current = document.getSelection();
      if (current && !current.isCollapsed) return;
      if (markupRef.current?.markAt(e.clientX, e.clientY)) return; // highlights take precedence
      const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
      const pageNumber = Number(pageEl?.dataset.pageNumber);
      const view = pageNumber ? (viewerRef.current?.getPageView(pageNumber - 1) as unknown as
        { pdfPage?: { imageCoordinates?: ArrayLike<number> | null }; viewport?: { rotation: number } } | undefined) : undefined;
      const surface = pageEl?.querySelector(".canvasWrapper");
      if (!view?.pdfPage || !view.viewport || !surface) return;
      const box = surface.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      const y = (e.clientY - box.top) / box.height;
      const hits = imageRegions(view.pdfPage, view.viewport.rotation).filter((r) => {
        const w = (r.right - r.left) * box.width;
        const h = (r.bottom - r.top) * box.height;
        // Skip tiny icons and full-page images (scanned pages), where a menu would just get in the way.
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && w >= 40 && h >= 40 && (r.right - r.left) * (r.bottom - r.top) < 0.85;
      });
      if (!hits.length) return;
      const region = hits.reduce((a, b) => ((a.right - a.left) * (a.bottom - a.top) <= (b.right - b.left) * (b.bottom - b.top) ? a : b));
      const link = document.elementsFromPoint(e.clientX, e.clientY)
        .find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && /^https?:/i.test(el.href) && !!el.closest(".annotationLayer"));
      e.preventDefault();
      e.stopPropagation();
      setHighlightMenu(null);
      const stage = container.parentElement!.getBoundingClientRect();
      setImageMenu({ target: { pageNumber, region, rotation: view.viewport.rotation, href: link?.href ?? null }, x: e.clientX - stage.left, y: e.clientY - stage.top });
    };
    const onScroll = () => setImageMenu(null);
    container.addEventListener("click", onClick, true);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("scroll", onScroll);
    };
  }, [container]);
  useEffect(() => { setImageMenu(null); setImageView(null); }, [doc]);
  const menuMark = highlightMenu ? markup.marks.find((m) => m.id === highlightMenu.id) : undefined;

  const removeHighlight = (id: string) => {
    markupRef.current!.remove(id);
    setHighlightMenu(null);
    flash("Highlight removed");
  };

  const askAbout = (text: string, pageNumber: number) => {
    setAiContext({ text, page: pageNumber });
    setAiOpen(true);
    document.getSelection()?.removeAllRanges();
  };

  useEffect(() => setContainer(containerRef.current), []);
  // Panels and focus mode change the space the page has: re-fit "auto"/"fit" zoom once they finish sliding.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const v = viewerRef.current;
      if (v?.pdfDocument && FIT_SCALES.includes(v.currentScaleValue)) v.currentScaleValue = v.currentScaleValue;
    }, 280);
    return () => window.clearTimeout(timer);
  }, [aiOpen, sidebar, sidebarTab, focus]);
  useEffect(() => {
    const stage = container?.parentElement;
    if (!stage) return;
    const observer = new ResizeObserver(() => setStageWidth(stage.clientWidth));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [container]);

  // pdf.js shows a small note button on highlights that have a note; open Readr's note box from it.
  useEffect(() => {
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const button = (e.target as HTMLElement).closest(".annotationCommentButton");
      const editorDiv = button?.parentElement?.closest<HTMLElement>("[id]");
      const markId = editorDiv && markupRef.current?.markForEditorId(editorDiv.id);
      if (!button || !markId) return;
      e.preventDefault();
      e.stopPropagation();
      const mark = markupRef.current!.state.marks.find((m) => m.id === markId);
      const stage = container.parentElement!.getBoundingClientRect();
      const r = button.getBoundingClientRect();
      setNoteBox({ markId, anchor: { x: r.left + r.width / 2 - stage.left, top: r.top - stage.top, bottom: r.bottom - stage.top },
        quote: mark?.text ?? "", initial: mark?.note ?? "" });
    };
    container.addEventListener("click", onClick, true);
    return () => container.removeEventListener("click", onClick, true);
  }, [container]);

  // Save notes and highlights before the window goes away.
  useEffect(() => {
    const flush = () => { markupRef.current?.sync(); markupRef.current?.flush(); };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const currentBytes = async () => {
    if (!doc) return null;
    // Marks on pages that haven't been drawn yet aren't in pdf.js's annotation storage; add them for this copy only.
    // (pdf.js saves only entries keyed with its editor prefix.)
    const storage = doc.pdf.annotationStorage;
    const unrendered = (await markupRef.current?.unrenderedMarks(doc.pdf)) ?? [];
    const keys = unrendered.map((data, i) => {
      const key = `pdfjs_internal_editor_folio-unrendered-${i}`;
      storage.setValue(key, data);
      return key;
    });
    try {
      const annotated = storage.size > 0;
      return { bytes: annotated ? await doc.pdf.saveDocument() : await doc.pdf.getData(), annotated };
    } finally {
      for (const key of keys) storage.remove(key);
    }
  };

  const saveBytes = (bytes: Uint8Array) => {
    const url = URL.createObjectURL(pdfBlob(bytes));
    const a = document.createElement("a");
    a.href = url;
    a.download = doc ? (doc.name.toLowerCase().endsWith(".pdf") ? doc.name : `${doc.name}.pdf`) : "document.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const download = async () => {
    let copy: Awaited<ReturnType<typeof currentBytes>>;
    try {
      copy = await currentBytes();
    } catch {
      setError("Couldn't save a copy of this document.");
      return;
    }
    if (!copy) return;
    saveBytes(copy.bytes);
    flash(copy.annotated ? "Saved a copy with your highlights and notes" : "Download started");
  };

  const print = async () => {
    // pdf.js marks the document as saved once it has written the bytes, but printing saves nothing.
    const unsaved = dirtyRef.current;
    let copy: Awaited<ReturnType<typeof currentBytes>>;
    try {
      copy = await currentBytes();
    } catch {
      setError("Couldn't print this document.");
      return;
    } finally {
      if (unsaved) setDirty(true);
    }
    if (!copy) return;
    const { bytes } = copy;
    const url = URL.createObjectURL(pdfBlob(bytes));
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = url;
    frame.onload = () => {
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          // The desktop shell denies blob: pop-ups, so a saved copy is the working fallback there.
          if (window.folioDesktop) { saveBytes(bytes); flash("Couldn't print — saved a copy instead"); }
          else window.open(url, "_blank");
        }
      }, 250);
    };
    document.body.appendChild(frame);
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  // Desktop app: PDFs (and converted Word documents) opened from Explorer, and a title bar that matches the theme.
  useEffect(() => {
    let cancelled = false;
    const generation = openGeneration.current;
    const unsubscribe = window.folioDesktop?.onOpenFile((name, data, note) => {
      setToast(null);
      if (!mayReplaceDocument()) return setLoading(false);
      void openBytes(name, data).then(() => { if (note && docRef.current?.name === name) flash(note); });
    });
    const unsubscribeConverting = window.folioDesktop?.onConverting((name) => {
      setLoading(true);
      setError(null);
      setToast(`Converting ${name} to PDF…`);
    });
    const unsubscribeFailed = window.folioDesktop?.onOpenFailed((message) => {
      setToast(null);
      setLoading(false);
      setError(message);
    });
    void (async () => {
      const hasStartupFile = await window.folioDesktop?.ready();
      if (hasStartupFile || cancelled || generation !== openGeneration.current) return;
      const id = activeDocument();
      const recent = id ? await getRecent(id) : undefined;
      if (!recent || cancelled || generation !== openGeneration.current) return;
      const data = new Uint8Array(await recent.data.arrayBuffer());
      if (!cancelled && generation === openGeneration.current) void openBytes(recent.name, data);
    })().catch(() => {}); // restoring the last document is best-effort
    return () => { cancelled = true; unsubscribe?.(); unsubscribeConverting?.(); unsubscribeFailed?.(); };
  }, [openBytes]);
  useEffect(() => window.folioDesktop?.setTheme(theme), [theme]);
  // The update banner appears once a new version has been downloaded (the status reports that right away too).
  useEffect(() => window.folioDesktop?.onUpdateStatus((status) => {
    if (status.state === "ready" && status.version) setUpdateVersion(status.version);
  }), []);

  const setThemeTo = (next: "light" | "dark") => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("folio:theme", next);
    setTheme(next);
  };

  const toggleFocus = async () => {
    const next = !focus;
    setFocus(next);
    try {
      if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!next && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* fullscreen can be refused; focus mode still hides the chrome */
    }
  };

  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setFocus(false);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => localStorage.setItem("folio:sidebar", sidebar ? "1" : "0"), [sidebar]);
  const setNightTo = (next: boolean) => {
    try { localStorage.setItem("folio:night", next ? "1" : "0"); }
    catch { flash("Night reading changed, but couldn't save the preference."); }
    setNight(next);
  };

  // Warn before losing unsaved annotations.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (signing) return;
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, [contenteditable=true], .freeTextEditor");

      if (mod && e.key === ",") {
        e.preventDefault();
        setDialog("settings");
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (e.shiftKey) openUrlDialog();
        else pickFile();
        return;
      }
      if (!docRef.current) return;

      if (mod && !typing && Number(viewerRef.current?.annotationEditorMode) === AnnotationEditorType.NONE
        && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        busRef.current?.dispatch("editingaction", { source: null, name: e.shiftKey || e.key.toLowerCase() === "y" ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => document.getElementById("folio-search")?.focus());
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        download();
      } else if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        print();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoom(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        setScaleValue("auto");
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (typing || mod || e.altKey) {
        return;
      } else if (selection && tool === "select" && /^h$/i.test(e.key)) {
        e.preventDefault();
        void quickHighlight(highlightColor);
      } else if (selection && tool === "select" && /^n$/i.test(e.key)) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".pop-note")?.focus();
      } else if (highlightMenu && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        removeHighlight(highlightMenu.id);
      } else if (e.key === "Escape") {
        if (highlightMenu) setHighlightMenu(null);
        else if (noteBox) setNoteBox(null);
        // Each dialog's Modal closes itself on Escape (the changelog goes back to Settings); closing here too would override it.
        else if (dialog) return;
        else if (searchOpen) setSearchOpen(false);
        else if (tool !== "select") chooseTool("select");
        else if (focus) toggleFocus();
      } else if (e.key === "f" || e.key === "F") {
        toggleFocus();
      } else if (e.key === "?") {
        setDialog("shortcuts");
      } else if (e.key === "2") {
        toggleSpread();
      } else if (e.key === "r" || e.key === "R") {
        rotate();
      } else {
        const t = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
        if (t) chooseTool(t.id);
        else if (e.key === "Home") goTo(1);
        else if (e.key === "End") goTo(numPages);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Drag & drop anywhere ────────────────────────────────────────────
  useEffect(() => {
    let depth = 0;
    let internal = false; // dragging text or images from inside Readr isn't an "open" gesture
    const hasFiles = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      return !internal && (types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain"));
    };
    const droppedUrl = (data: DataTransfer) => {
      const fromList = data.getData("text/uri-list").split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"));
      return parseWebUrl(fromList) ?? parseWebUrl(data.getData("text/plain"));
    };
    const start = () => (internal = true);
    const end = () => (internal = false);
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      const url = !file && e.dataTransfer ? droppedUrl(e.dataTransfer) : null;
      if (file) void openFile(file);
      else if (url) openUrlDialog(url);
      else setError("Drop a PDF file or a link to a PDF.");
    };
    // Pasting a link (outside text fields) fills in Open from URL too.
    const paste = (e: ClipboardEvent) => {
      if (signing || (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true], .freeTextEditor")) return;
      const url = parseWebUrl(e.clipboardData?.getData("text/plain"));
      if (!url) return;
      e.preventDefault();
      openUrlDialog(url);
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("paste", paste);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("paste", paste);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openFile, signing]);

  const runFind = (query: string, opts: { again?: boolean; previous?: boolean; caseSensitive?: boolean; entireWord?: boolean }) =>
    busRef.current!.dispatch("find", {
      source: null,
      type: opts.again ? "again" : "",
      query,
      caseSensitive: !!opts.caseSensitive,
      entireWord: !!opts.entireWord,
      highlightAll: true,
      findPrevious: !!opts.previous,
      matchDiacritics: false,
    });

  const closeSearch = () => {
    setSearchOpen(false);
    busRef.current!.dispatch("findbarclose", { source: null });
  };

  const isEditing = tool !== "select";

  return (
    <div
      className="app"
      data-focus={focus || undefined}
      data-sidebar={(sidebar && !!doc && !focus) || undefined}
      data-night={night || undefined}
      data-tool={tool}
    >
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand" onClick={doc ? closeDoc : undefined} title={doc ? "Back to library" : "Readr"}>
            <span className="brand-mark" />
            <span className="brand-name">Readr</span>
          </button>
          {doc && (
            <>
              <IconButton icon="sidebar" label={keys("Toggle sidebar (Ctrl+\\)")} active={sidebar} onClick={() => setSidebar(!sidebar)} />
              <div className="doc-title" title={doc.name}>
                <span>{doc.name.replace(/\.pdf$/i, "")}</span>
                {dirty && <span className="dirty-dot" title="Unsaved annotations" />}
              </div>
            </>
          )}
        </div>

        <div className="topbar-center">
          {doc && (
            <div className="segmented" role="toolbar" aria-label="Tools">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={tool === t.id ? "on" : ""}
                  onClick={() => chooseTool(t.id)}
                  title={`${t.label} (${t.key})`}
                >
                  <Icon name={t.icon} size={16} />
                  <span>{t.label}</span>
                </button>
              ))}
              <button onClick={startSigning} title="Add a signature"><Icon name="signature" size={16} /><span>Sign</span></button>
            </div>
          )}
        </div>

        <div className="topbar-right">
          {doc && (
            <>
              <IconButton icon="sparkle" label="Ask AI" active={aiOpen} onClick={() => setAiOpen(!aiOpen)} />
              <IconButton icon="search" label={keys("Search (Ctrl+F)")} active={searchOpen} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))} />
            </>
          )}
          <MoreMenu
            items={[
              ...(doc
                ? ([
                    { kind: "action", icon: "download", label: "Save a copy", shortcut: keys("Ctrl S"), onSelect: download },
                    { kind: "action", icon: "print", label: "Print", shortcut: keys("Ctrl P"), onSelect: print },
                    { kind: "action", icon: "info", label: "Document info", onSelect: () => setDialog("info") },
                    { kind: "divider" },
                    { kind: "action", icon: "expand", label: "Focus mode", shortcut: "F", onSelect: toggleFocus },
                  ] as MoreItem[])
                : []),
              { kind: "action", icon: "settings", label: "Settings", shortcut: keys("Ctrl ,"), onSelect: () => setDialog("settings") },
              { kind: "action", icon: "keyboard", label: "Keyboard shortcuts", shortcut: "?", onSelect: () => setDialog("shortcuts") },
              { kind: "action", icon: "info", label: "About Readr", onSelect: () => setDialog("about") },
            ]}
          />
        </div>
      </header>

      <div className="body">
        {doc && (
          <Sidebar
            pdf={doc.pdf}
            page={page}
            rotation={rotation}
            onSelectPage={goTo}
            onSelectDest={(dest) => linkRef.current!.goToDestination(dest as string)}
            tab={sidebarTab}
            onTab={setSidebarTab}
            noteCount={markup.marks.filter((m) => m.type === "highlight").length}
            notes={
              <NotesPanel
                state={markup}
                docName={doc.name}
                persisted={persistRef.current}
                onReveal={(id) => markupRef.current!.reveal(id)}
                onNote={(id, note) => markupRef.current!.setNote(id, note)}
                onRemove={(id) => markupRef.current!.remove(id)}
                onDocNote={(note) => markupRef.current!.setDocNote(note)}
                onAsk={(mark: Mark) => askAbout(mark.text, mark.page + 1)}
              />
            }
          />
        )}

        <main className="stage">
          <div ref={containerRef} className="viewer-container" tabIndex={-1}>
            <div ref={innerRef} className="pdfViewer" />
          </div>

          {doc && searchOpen && (
            <>
              <SearchBar result={find} onFind={runFind} onClose={closeSearch} />
              <SearchResults pdf={doc.pdf} controller={findRef.current!} bus={busRef.current!} onSelect={goTo} />
            </>
          )}

          {doc && isEditing && PALETTE[tool] && (
            <div className="color-pill" role="radiogroup" aria-label="Color">
              {PALETTE[tool]!.map((c) => (
                <button
                  key={c.hex}
                  className={colors[tool] === c.hex ? "on" : ""}
                  style={{ "--swatch": c.hex } as React.CSSProperties}
                  onClick={() => chooseColor(c.hex)}
                  title={c.name}
                  role="radio"
                  aria-checked={colors[tool] === c.hex}
                />
              ))}
              <span className="divider" />
              <button className="pill-btn" onClick={() => busRef.current!.dispatch("editingaction", { source: null, name: "undo" })} title={keys("Undo (Ctrl+Z)")}>
                <Icon name="undo" size={16} />
              </button>
              <button className="pill-done" onClick={() => chooseTool("select")}>Done</button>
            </div>
          )}

          {doc && (
            <div className="pill" role="toolbar" aria-label="Navigation">
              <button className="pill-btn" onClick={() => goTo(page - 1)} disabled={page <= 1} title="Previous page">
                <Icon name="chevronUp" size={17} />
              </button>
              <form
                className="page-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = parseInt(pageInput, 10);
                  if (Number.isFinite(n)) goTo(n);
                  else setPageInput(String(page));
                  (document.activeElement as HTMLElement)?.blur();
                }}
              >
                <input
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => setPageInput(String(pageRef.current))}
                  style={{ width: `${Math.max(2, String(numPages).length) + 0.6}ch` }}
                  aria-label="Page number"
                />
                <span className="page-total">of {numPages}</span>
              </form>
              <button className="pill-btn" onClick={() => goTo(page + 1)} disabled={page >= numPages} title="Next page">
                <Icon name="chevronDown" size={17} />
              </button>
              <span className="divider" />
              <button className="pill-btn" onClick={() => zoom(-1)} title={keys("Zoom out (Ctrl −)")}>
                <Icon name="minus" size={17} />
              </button>
              <ZoomMenu scale={scale} onPick={setScaleValue} spread={spread} onToggleSpread={toggleSpread} />
              <button className="pill-btn" onClick={() => zoom(1)} title={keys("Zoom in (Ctrl +)")}>
                <Icon name="plus" size={17} />
              </button>
              <span className="divider wide-only" />
              <button className="pill-btn wide-only" onClick={rotate} title="Rotate (R)">
                <Icon name="rotate" size={17} />
              </button>
            </div>
          )}

          {selection && !noteBox && !highlightMenu && (
            <SelectionPopover
              key={`${selection.page}:${selection.top}:${selection.text.slice(0, 40)}`}
              info={selection}
              stageWidth={stageWidth}
              colors={HIGHLIGHTS}
              current={highlightColor}
              onHighlight={(hex, note) => void quickHighlight(hex, note)}
              onAsk={() => { setPinned(null); askAbout(selection.text, selection.page); }}
              onPin={() => setPinned(selection)}
              onDismiss={dismissSelection}
            />
          )}
          {imageMenu && (
            <ImageMenu
              x={imageMenu.x}
              y={imageMenu.y}
              stageWidth={stageWidth}
              href={imageMenu.target.href}
              onView={() => { setImageView(imageMenu.target); setImageMenu(null); }}
              onOpen={() => { window.open(imageMenu.target.href!, "_blank", "noopener"); setImageMenu(null); }}
            />
          )}
          {highlightMenu && menuMark && !noteBox && (
            <HighlightMenu
              rect={highlightMenu.rect}
              stageWidth={stageWidth}
              colors={HIGHLIGHTS}
              current={menuMark.color}
              hasNote={!!menuMark.note}
              onRecolor={(hex) => markupRef.current!.recolor(menuMark.id, hex)}
              onNote={() => {
                const r = highlightMenu.rect;
                setNoteBox({ markId: menuMark.id, anchor: { x: (r.left + r.right) / 2, top: r.top, bottom: r.bottom }, quote: menuMark.text, initial: menuMark.note });
                setHighlightMenu(null);
              }}
              onAsk={() => { askAbout(menuMark.text, menuMark.page + 1); setHighlightMenu(null); }}
              onRemove={() => removeHighlight(menuMark.id)}
            />
          )}
          {noteBox && (
            <NoteBox
              key={noteBox.markId}
              anchor={noteBox.anchor}
              stageWidth={stageWidth}
              quote={noteBox.quote}
              initial={noteBox.initial}
              onSave={(note) => markupRef.current!.setNote(noteBox.markId, note)}
              onClose={() => setNoteBox(null)}
            />
          )}

          {focus && (
            <button className="exit-focus" onClick={toggleFocus} title="Exit focus mode">
              <kbd>Esc</kbd> to exit focus mode
            </button>
          )}
        </main>

        {doc && aiOpen && !focus && (
          <AiPanel
            key={doc.key}
            pdf={doc.pdf}
            docId={doc.key}
            persist={persistRef.current}
            docName={doc.name}
            context={aiContext}
            onClearContext={() => setAiContext(null)}
            onGoToPage={goTo}
            onClose={() => setAiOpen(false)}
          />
        )}
      </div>

      {!doc && <Welcome onPick={pickFile} onOpenUrl={() => openUrlDialog()} onOpenBytes={openBytes} onError={setError} onSample={openSample} loading={loading} />}

      {loading && doc && <div className="loading-bar" />}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="upload" size={30} />
            <p>Drop a PDF or link to open</p>
          </div>
        </div>
      )}

      {pending && (
        <PasswordDialog
          name={pending.name}
          error={pending.error}
          onSubmit={(pw) => openBytes(pending.name, pending.data, pw)}
          onCancel={() => setPending(null)}
        />
      )}
      {dialog === "info" && doc && <InfoDialog pdf={doc.pdf} name={doc.name} size={doc.size} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} onOpenSettings={() => setDialog("settings")} />}
      {dialog === "settings" && <SettingsDialog theme={theme} onTheme={setThemeTo} night={night} onNight={setNightTo} onOpenChangelog={() => setDialog("changelog")} onClose={() => setDialog(null)} />}
      {/* Closing goes back to Settings, where the changelog is opened from. */}
      {dialog === "changelog" && <ChangelogDialog onClose={() => setDialog("settings")} />}
      {doc && imageView && <ImageViewer pdf={doc.pdf} target={imageView} onClose={() => setImageView(null)} />}
      {dialog === "url" && <OpenUrlDialog key={linkDraft} initial={linkDraft} onClose={() => setDialog(null)} onSubmit={(url) => { setDialog(null); openUrl(url); }} />}
      {doc && signing && <SignatureDialog key={doc.id + ":" + page} pdf={doc.pdf} pageNumber={page} targets={signatureTargets}
        onClose={() => setSigning(false)} onApprove={async (signature, rect) => {
          await placeSignature(viewerRef.current!, doc.pdf, page, signature, rect);
          setDirty(true); setSignatureDismissed(true); flash(keys("Signature added. Ctrl+Z to undo; Save copy to export."));
        }} />}
      {doc && !signing && signatureTargets.length > 0 && !signatureDismissed && <div className="signature-suggestion" role="status">
        <span>{signatureTargets[0].kind === "field" ? "Signature field detected" : "Possible signature area"} on page {page}</span>
        <button className="btn primary" onClick={startSigning}>Review signature</button>
        <button className="pill-btn" aria-label="Dismiss signature suggestion" onClick={() => setSignatureDismissed(true)}><Icon name="close" size={14} /></button>
      </div>}

      {updateVersion && (
        <div className="update-card" role="status">
          <div>
            <strong>Readr {updateVersion} is ready</strong>
            <span>Restart to update. Installation on close follows your auto-update setting.</span>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              if (dirty && !confirm("You have unsaved annotations. Restart anyway?")) return;
              window.folioDesktop?.installUpdate();
            }}
          >
            Restart
          </button>
          <button className="pill-btn" onClick={() => setUpdateVersion(null)} aria-label="Later" title="Later">
            <Icon name="close" size={15} />
          </button>
        </div>
      )}

      {(toast || error) && (
        <div className={`toast ${error ? "error" : ""}`} onClick={() => setError(null)}>
          {error ?? toast}
        </div>
      )}
    </div>
  );
}

function IconButton({ icon, label, onClick, active }: { icon: IconName; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button className={`icon-btn ${active ? "on" : ""}`} onClick={onClick} title={label} aria-label={label} aria-pressed={active}>
      <Icon name={icon} />
    </button>
  );
}
