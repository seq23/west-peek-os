import { useEffect, useState } from "react";
import { getDevUser } from "../lib/api";

/**
 * A DOCUMENT, SHOWN IN PLACE.
 *
 * Fetched with the same identity every other call uses and shown from a blob URL — not an iframe
 * pointed at the download route. An iframe carries only cookies, so it worked behind Cloudflare
 * Access in production and rendered `{"error":"unauthenticated"}` everywhere the identity is a
 * header (local, tests, the review that found this on 15 Sep 2026). One component, both pages,
 * one way of showing a PDF.
 */
export function DocumentPreview({ documentId, title, height = "60vh" }: { documentId: string; title: string; height?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setProblem(null);
    const headers: Record<string, string> = {};
    const devUser = getDevUser();
    if (devUser) headers["x-wpos-dev-user"] = devUser;
    fetch(`/api/documents/${documentId}/download`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
        setUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProblem(`Could not load the document (${err instanceof Error ? err.message : String(err)}).`);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId]);
  if (problem) return <p className="state-message" data-testid="document-preview-problem">{problem}</p>;
  if (!url) return <p className="state-message" data-testid="document-preview-loading">Loading {title}…</p>;
  return (
    <iframe
      title={title}
      src={url}
      data-testid="document-preview"
      style={{ width: "100%", height, border: "1px solid var(--wp-line)", background: "var(--wp-surface)" }}
    />
  );
}
