import * as React from "react";

// Renders the small Markdown subset the help guides use (src/content/help.ts):
// "### " headings, paragraphs, "- " bullets, "1. " numbered items, **bold** and
// *italic*. Nothing else is interpreted, so the text reads exactly as approved.

type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };

export function parseHelpBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      blocks.push({ type: "heading", text: line.slice(4) });
      continue;
    }
    const bullet = /^- (.*)$/.exec(line);
    const numbered = /^\d+\. (.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const text = (bullet ?? numbered)![1]!;
      const last = blocks[blocks.length - 1];
      if (last && last.type === "list" && last.ordered === ordered) last.items.push(text);
      else blocks.push({ type: "list", ordered, items: [text] });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

export function HelpArticle({ body }: { body: string }) {
  const blocks = parseHelpBlocks(body);
  return (
    <div className="max-w-2xl space-y-4 text-[15px] leading-relaxed">
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          return (
            <h2 key={i} className="pt-3 text-lg font-semibold tracking-tight">
              {block.text}
            </h2>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} className={block.ordered ? "list-decimal space-y-2 pl-5" : "list-disc space-y-2 pl-5"}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
