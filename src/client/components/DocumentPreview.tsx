import { useEffect, useState } from "react";
import { getDevUser } from "../lib/api";
import { isMarkdownType } from "@shared/documents/markdown";
import { MarkdownDocument } from "./MarkdownDocument";

/**
 * A DOCUMENT, SHOWN IN PLACE — each kind the way it reads best.
 *
 * Fetched with the same identity every other call uses and shown from the bytes — not an iframe
 * pointed at the download route. An iframe carries only cookies, so it worked behind Cloudflare
 * Access in production and rendered `{"error":"unauthenticated"}` everywhere the identity is a
 * header (local, tests, the review that found this on 15 Sep 2026).
 *
 * BY KIND (owner, 23 Oct 2026: "make sure it is formatted properly for my consumption"). Markdown
 * was shown as raw monospace in a frame; now:
 *   - Markdown → a typeset document (`MarkdownDocument`): headings, bold, lists, tables, links;
 *   - HTML → its own page, in a SANDBOXED frame with scripts off (`sandbox=""`);
 *   - PDF → the browser's PDF viewer, as before; images → the picture itself;
 *   - plain text, CSV, JSON → wrapped, readable text;
 *   - anything else (a .pptx, a .docx) → a sentence saying it opens after Download.
 * Text is decoded as UTF-8 whatever the stored type says, so "·" never reads as "Â·".
 */
type Shown =
  | { kind: "markdown"; text: string }
  | { kind: "html"; text: string }
  | { kind: "text"; text: string }
  | { kind: "pdf"; url: string }
  | { kind: "image"; url: string }
  | { kind: "other"; type: string };

export function DocumentPreview({ documentId, title, height = "60vh" }: { documentId: string; title: string; height?: string }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setShown(null);
    setProblem(null);
    const headers: Record<string, string> = {};
    const devUser = getDevUser();
    if (devUser) headers["x-wpos-dev-user"] = devUser;
    fetch(`/api/documents/${documentId}/download`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        const bytes = await res.arrayBuffer();
        if (cancelled) return;
        const text = () => new TextDecoder("utf-8").decode(bytes);
        if (isMarkdownType(type, title)) return setShown({ kind: "markdown", text: text() });
        if (type.startsWith("text/html")) return setShown({ kind: "html", text: text() });
        if (type.startsWith("text/") || type.startsWith("application/json")) return setShown({ kind: "text", text: text() });
        if (type.startsWith("image/") && !type.startsWith("image/svg")) {
          objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
          return setShown({ kind: "image", url: objectUrl });
        }
        if (type === "" || type.startsWith("application/pdf") || type === "application/octet-stream") {
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          return setShown({ kind: "pdf", url: objectUrl });
        }
        return setShown({ kind: "other", type });
      })
      .catch((err: unknown) => {
        if (!cancelled) setProblem(`Could not load the document (${err instanceof Error ? err.message : String(err)}).`);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, title]);
  if (problem) return <p className="state-message" data-testid="document-preview-problem">{problem}</p>;
  if (!shown) return <p className="state-message" data-testid="document-preview-loading">Loading {title}…</p>;
  switch (shown.kind) {
    case "markdown":
      return (
        <div data-testid="document-preview" data-kind="markdown">
          <MarkdownDocument source={shown.text} />
        </div>
      );
    case "text":
      return (
        <div data-testid="document-preview" data-kind="text">
          <pre className="doc-plain">{shown.text}</pre>
        </div>
      );
    case "html":
      return (
        <iframe
          title={title}
          srcDoc={shown.text}
          sandbox=""
          data-testid="document-preview"
          data-kind="html"
          className="doc-frame"
          style={{ height }}
        />
      );
    case "image":
      return (
        <div data-testid="document-preview" data-kind="image">
          <img src={shown.url} alt={title} className="doc-image" />
        </div>
      );
    case "pdf":
      return <iframe title={title} src={shown.url} data-testid="document-preview" data-kind="pdf" className="doc-frame" style={{ height }} />;
    case "other":
      return (
        <p className="state-message" data-testid="document-preview" data-kind="other">
          This kind of file ({shown.type || "unknown type"}) cannot be shown here. Use Download to open it on your device.
        </p>
      );
  }
}
