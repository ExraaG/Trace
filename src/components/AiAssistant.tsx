import { Bot, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askProvider, PROVIDERS } from "../ai/providers";
import type { AiMessage, AiProvider } from "../types";

interface AiAssistantProps {
  provider: AiProvider;
  apiKey: string;
  model: string;
  customUrl: string;
  currentCode: string;
  explainPrompt: string | null;
  onExplainConsumed: () => void;
  onProposeCode: (code: string) => void;
}

interface ChatMessage extends AiMessage {
  codeEdit?: boolean;
}

function isCodeWritingRequest(content: string) {
  return /\b(write|create|generate|make|replace|rewrite|edit|change|update|modify|fix|implement|add|remove)\b/i.test(content)
    && /\b(code|sketch|program|file|ino|editor|arduino|esp32)\b/i.test(content);
}

function extractReplacement(content: string) {
  const tagged = content.match(/<trace-code>\s*([\s\S]*?)\s*<\/trace-code>/i);
  if (tagged?.[1]) return tagged[1].trim();
  const fenced = content.match(/```(?:cpp|c\+\+|arduino|ino)?\s*\n([\s\S]*?)```/i);
  return fenced?.[1]?.trim() ?? null;
}

function visibleMessage(message: ChatMessage) {
  if (!message.codeEdit) return message.content;
  const lower = message.content.toLowerCase();
  const taggedStart = lower.indexOf("<trace-code>");
  const fencedStart = message.content.indexOf("```");
  const codeStart = [taggedStart, fencedStart].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  const explanation = (codeStart === undefined ? message.content : message.content.slice(0, codeStart)).trim();
  return explanation || "Preparing code changes in the editor…";
}

export function AiAssistant({
  provider,
  apiKey,
  model,
  customUrl,
  currentCode,
  explainPrompt,
  onExplainConsumed,
  onProposeCode,
}: AiAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (explainPrompt === null) return;
    setInput(explainPrompt);
    onExplainConsumed();
  }, [explainPrompt, onExplainConsumed]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  const proposeReplacement = (response: string) => {
    const replacement = extractReplacement(response);
    if (!replacement) return false;
    onProposeCode(replacement);
    setEditorNotice("Proposed changes are open in the editor. Review the red and green diff, then apply or discard them.");
    return true;
  };

  const submit = async () => {
    const content = input.trim();
    if (!content || loading) return;
    const wantsCode = isCodeWritingRequest(content);
    const displayedMessages = [...messages, { role: "user", content } satisfies ChatMessage];
    const requestMessages = displayedMessages.map(({ role, content: messageContent }, index) => {
      const message = { role, content: messageContent } satisfies AiMessage;
      if (!wantsCode || index !== displayedMessages.length - 1) return message;
      return {
        ...message,
        content: `${content}\n\nReplace the current Trace editor buffer with a complete working sketch. Return the entire replacement inside <trace-code>...</trace-code>.\n\n<trace-current-code>\n${currentCode}\n</trace-current-code>`,
      };
    });
    setMessages(displayedMessages);
    setInput("");
    setError(null);
    setEditorNotice(null);
    setLoading(true);
    let streamed = "";
    try {
      const response = await askProvider(provider, apiKey, model, requestMessages, customUrl, (delta) => {
        streamed += delta;
        setMessages([...displayedMessages, { role: "assistant", content: streamed, codeEdit: wantsCode }]);
      });
      setMessages([...displayedMessages, { role: "assistant", content: response, codeEdit: wantsCode }]);
      if (wantsCode && !proposeReplacement(response)) {
        setEditorNotice("The model did not return a complete replacement sketch, so the editor was left unchanged.");
      }
    } catch (reason) {
      if (!streamed) setMessages(displayedMessages);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel-shell border-l border-line" aria-label="AI assistant">
      <div className="panel-header">
        <Bot size={13} />
        <span>AI assistant</span>
        <span className="ml-auto max-w-36 truncate normal-case tracking-normal text-zinc-600" title={model}>
          {PROVIDERS[provider].label} · {model}
        </span>
      </div>
      <div className="ai-scroll">
        {messages.length === 0 && (
          <div className="ai-empty">
            <Sparkles size={18} />
            <p>Ask about ESP32, Arduino code, or a build error.</p>
            <span>Ask Trace to “write code” to replace the current editor buffer. Changes remain unsaved until you save the sketch.</span>
            <span>{provider === "custom" ? `Requests go directly to ${customUrl}.` : `Requests go directly to ${PROVIDERS[provider].label} using your key.`}</span>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`ai-message ${message.role}`}>
            <span>{message.role === "user" ? "You" : "Trace"}</span>
            <p>{visibleMessage(message)}</p>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="ai-spinner" aria-hidden="true" /> Thinking…
          </div>
        )}
        {editorNotice && <div className="rounded border border-emerald-900/60 bg-emerald-950/20 p-2 text-xs text-emerald-300">{editorNotice}</div>}
        {error && <div className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300">{error}</div>}
        <div ref={endRef} />
      </div>
      <form
        className="ai-input"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask Trace…"
          rows={3}
        />
        <button className="icon-button h-8 w-8" type="submit" disabled={!input.trim() || loading} aria-label="Send to assistant">
          {loading ? <span className="ai-spinner" aria-hidden="true" /> : <Send size={13} />}
        </button>
      </form>
    </section>
  );
}
