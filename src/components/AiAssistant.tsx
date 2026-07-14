import { Bot, LoaderCircle, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { askProvider, PROVIDERS } from "../ai/providers";
import type { AiMessage, AiProvider } from "../types";

interface AiAssistantProps {
  provider: AiProvider;
  apiKey: string;
  explainPrompt: string | null;
  onExplainConsumed: () => void;
}

export function AiAssistant({ provider, apiKey, explainPrompt, onExplainConsumed }: AiAssistantProps) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (explainPrompt === null) return;
    setInput(explainPrompt);
    onExplainConsumed();
  }, [explainPrompt, onExplainConsumed]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  const submit = async () => {
    const content = input.trim();
    if (!content || loading) return;
    const next = [...messages, { role: "user", content } satisfies AiMessage];
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);
    try {
      const response = await askProvider(provider, apiKey, next);
      setMessages((current) => [...current, { role: "assistant", content: response }]);
    } catch (reason) {
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
        <span className="ml-auto normal-case tracking-normal text-zinc-600">{PROVIDERS[provider].label}</span>
      </div>
      <div className="ai-scroll">
        {messages.length === 0 && (
          <div className="ai-empty">
            <Sparkles size={18} />
            <p>Ask about ESP32, Arduino code, or a build error.</p>
            <span>Requests go directly to {PROVIDERS[provider].label} using your key.</span>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`ai-message ${message.role}`}>
            <span>{message.role === "user" ? "You" : "Trace"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {loading && <div className="flex items-center gap-2 text-xs text-zinc-500"><LoaderCircle size={13} className="animate-spin" /> Thinking…</div>}
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
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}
        </button>
      </form>
    </section>
  );
}
