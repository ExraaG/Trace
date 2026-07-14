import { useEffect, useState } from "react";

interface StartupSplashProps {
  onComplete: () => void;
}

export function StartupSplash({ onComplete }: StartupSplashProps) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const leaveTimer = window.setTimeout(() => setLeaving(true), reducedMotion ? 250 : 1450);
    const completeTimer = window.setTimeout(onComplete, reducedMotion ? 450 : 1900);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div className={`startup-splash ${leaving ? "is-leaving" : ""}`} aria-label="Starting Trace">
      <div className="startup-grid" aria-hidden="true" />
      <div className="startup-core">
        <div className="startup-signal startup-signal-left" aria-hidden="true" />
        <div className="startup-signal startup-signal-right" aria-hidden="true" />
        <svg className="startup-logo" viewBox="0 0 512 512" role="img" aria-label="Trace">
          <rect className="startup-logo-shell" x="16" y="16" width="480" height="480" rx="104" />
          <g transform="translate(10 8)">
            <path className="startup-trace startup-trace-orange" d="M112 150h182c58 0 106 48 106 106s-48 106-106 106H218" />
            <path className="startup-trace startup-trace-white" d="M112 150v212" />
            <circle className="startup-node startup-node-one" cx="112" cy="150" r="21" />
            <circle className="startup-node startup-node-two" cx="112" cy="362" r="21" />
            <circle className="startup-node startup-node-three" cx="218" cy="362" r="21" />
          </g>
        </svg>
        <div className="startup-wordmark">TRACE</div>
        <div className="startup-status"><span /> Initializing workspace</div>
      </div>
    </div>
  );
}
