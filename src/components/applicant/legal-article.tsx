// A legal text rendered from Markdown by the small safe renderer in
// src/server/services/legal.ts (every character escaped, no raw HTML), so the
// HTML set here is ours. The arbitrary variants style the plain tags it emits.
export function LegalArticle({ html }: { html: string }) {
  return (
    <article
      className="space-y-3 text-[15px] leading-relaxed [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_hr]:my-6 [&_li]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:text-sm [&_td]:border-t [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:space-y-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function LegalMissing({ title }: { title: string }) {
  return (
    <article className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">This page is not available yet. Call or text 763-292-2259 with any question.</p>
    </article>
  );
}
