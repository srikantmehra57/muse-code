import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { openUrl } from "../lib/bridge";
import { copyText } from "../lib/format";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  if (!code) return <pre>{children}</pre>;
  const lang = /language-(\S+)/.exec(code.className ?? "")?.[1];
  const copy = () => {
    void copyText(textOf(code.children).replace(/\n$/, "")).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang ?? "code"}</span>
        <button type="button" className="codeblock-copy" aria-label={copied ? "Copied to clipboard" : "Copy code"} onClick={copy}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                if (href) void openUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          pre: CodeBlock,
          table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
