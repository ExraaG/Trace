import * as Blockly from "blockly/core";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  arduinoToolbox,
  createStarterBlocks,
  generateArduinoCode,
  loadArduinoCode,
  registerArduinoBlocks,
} from "../blocks/arduino";

const traceBlocklyTheme = Blockly.Theme.defineTheme("trace-blocks", {
  name: "trace-blocks",
  base: Blockly.Themes.Classic,
  blockStyles: {
    trace_structure_blocks: { colourPrimary: "#c2410c", colourSecondary: "#9a3412", colourTertiary: "#7c2d12" },
    trace_pin_blocks: { colourPrimary: "#ea580c", colourSecondary: "#c2410c", colourTertiary: "#9a3412" },
    trace_output_blocks: { colourPrimary: "#f97316", colourSecondary: "#ea580c", colourTertiary: "#c2410c" },
    trace_timing_blocks: { colourPrimary: "#ca8a04", colourSecondary: "#a16207", colourTertiary: "#854d0e" },
    trace_control_blocks: { colourPrimary: "#7c3aed", colourSecondary: "#6d28d9", colourTertiary: "#5b21b6" },
    trace_serial_blocks: { colourPrimary: "#0891b2", colourSecondary: "#0e7490", colourTertiary: "#155e75" },
    trace_variable_blocks: { colourPrimary: "#2563eb", colourSecondary: "#1d4ed8", colourTertiary: "#1e40af" },
    trace_function_blocks: { colourPrimary: "#0d9488", colourSecondary: "#0f766e", colourTertiary: "#115e59" },
    trace_code_blocks: { colourPrimary: "#64748b", colourSecondary: "#475569", colourTertiary: "#334155" },
    trace_advanced_blocks: { colourPrimary: "#475569", colourSecondary: "#334155", colourTertiary: "#1e293b" },
  },
  componentStyles: {
    workspaceBackgroundColour: "#09090b",
    toolboxBackgroundColour: "#111114",
    toolboxForegroundColour: "#d4d4d8",
    flyoutBackgroundColour: "#18181b",
    flyoutForegroundColour: "#e4e4e7",
    flyoutOpacity: 0.98,
    scrollbarColour: "#52525b",
    scrollbarOpacity: 0.55,
    insertionMarkerColour: "#fb923c",
    insertionMarkerOpacity: 0.45,
    cursorColour: "#fb923c",
  },
  fontStyle: { family: "Inter, ui-sans-serif, system-ui, sans-serif", weight: "500", size: 12 },
  startHats: true,
});

interface BlockEditorProps {
  active: boolean;
  code: string;
  onCodeChange: (code: string) => void;
}

export function BlockEditor({ active, code, onCodeChange }: BlockEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const onCodeChangeRef = useRef(onCodeChange);
  const codeRef = useRef(code);
  const applyingCodeRef = useRef(false);
  const lastGeneratedCodeRef = useRef<string | null>(null);
  onCodeChangeRef.current = onCodeChange;
  codeRef.current = code;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    registerArduinoBlocks();

    const workspace = Blockly.inject(container, {
      toolbox: arduinoToolbox,
      theme: traceBlocklyTheme,
      renderer: "zelos",
      trashcan: true,
      sounds: false,
      move: { scrollbars: true, drag: true, wheel: true },
      zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 1.4, minScale: 0.55, scaleSpeed: 1.1 },
      grid: { spacing: 24, length: 2, colour: "#27272a", snap: true },
    });
    workspaceRef.current = workspace;
    applyingCodeRef.current = true;
    loadArduinoCode(workspace, codeRef.current);
    applyingCodeRef.current = false;

    let generateTimer: number | null = null;
    const handleChange = (event: Blockly.Events.Abstract) => {
      if (applyingCodeRef.current || event.isUiEvent || event.type === Blockly.Events.FINISHED_LOADING) return;
      if (generateTimer !== null) window.clearTimeout(generateTimer);
      generateTimer = window.setTimeout(() => {
        generateTimer = null;
        const generated = generateArduinoCode(workspace);
        if (generated) {
          lastGeneratedCodeRef.current = generated;
          onCodeChangeRef.current(generated);
        }
      }, 40);
    };
    workspace.addChangeListener(handleChange);

    const resizeObserver = new ResizeObserver(() => Blockly.svgResize(workspace));
    resizeObserver.observe(container);
    Blockly.svgResize(workspace);

    return () => {
      if (generateTimer !== null) window.clearTimeout(generateTimer);
      resizeObserver.disconnect();
      workspace.removeChangeListener(handleChange);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || code === lastGeneratedCodeRef.current) return;
    const timer = window.setTimeout(() => {
      applyingCodeRef.current = true;
      try {
        loadArduinoCode(workspace, code);
        if (active) Blockly.svgResize(workspace);
      } finally {
        applyingCodeRef.current = false;
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [active, code]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!active || !workspace) return;
    const frame = window.requestAnimationFrame(() => Blockly.svgResize(workspace));
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const resetBlocks = () => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    createStarterBlocks(workspace);
    const generated = generateArduinoCode(workspace);
    lastGeneratedCodeRef.current = generated;
    onCodeChangeRef.current(generated);
    Blockly.svgResize(workspace);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#09090b]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-[#0d0d10] px-3 text-[11px] text-zinc-500">
        <span>Live sync · Code edits become blocks, and block edits update the same sketch.</span>
        <button className="panel-action ml-auto flex items-center gap-1" onClick={resetBlocks} title="Reset the visual sketch">
          <RotateCcw size={11} /> Reset blocks
        </button>
      </div>
      <div ref={containerRef} className="block-editor min-h-0 flex-1" />
    </section>
  );
}
