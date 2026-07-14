interface TraceMarkProps {
  className?: string;
}

export function TraceMark({ className }: TraceMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g transform="translate(10 8)">
        <path
          d="M112 150h182c58 0 106 48 106 106s-48 106-106 106H218"
          stroke="currentColor"
          strokeWidth="52"
          strokeLinecap="round"
        />
        <path
          d="M112 150v212"
          stroke="currentColor"
          strokeWidth="52"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
