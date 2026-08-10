const ARTIFACT_HTML_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
].join("; ");

export type AgentLoopArtifactHtmlPreviewProps = Readonly<{
  html: string;
  title: string;
}>;

/** Untrusted artifact HTML is a document in an opaque sandbox, never React DOM. */
export function AgentLoopArtifactHtmlPreview({ html, title }: AgentLoopArtifactHtmlPreviewProps) {
  const srcDoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
  return <iframe
    className="awb-agent-loop-artifact-html-preview"
    loading="lazy"
    referrerPolicy="no-referrer"
    sandbox=""
    srcDoc={srcDoc}
    title={title}
  />;
}
