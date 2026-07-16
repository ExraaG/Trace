import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { parseArduinoCode, type ArduinoStatement } from "./arduinoModel";

let registered = false;

const blockDefinitions = [
  {
    type: "trace_program",
    message0: "Arduino sketch",
    message1: "before setup %1",
    args1: [{ type: "input_statement", name: "BEFORE_SETUP" }],
    message2: "run once %1",
    args2: [{ type: "input_statement", name: "SETUP" }],
    message3: "between functions %1",
    args3: [{ type: "input_statement", name: "BETWEEN_FUNCTIONS" }],
    message4: "repeat forever %1",
    args4: [{ type: "input_statement", name: "LOOP" }],
    message5: "after loop %1",
    args5: [{ type: "input_statement", name: "AFTER_LOOP" }],
    style: "trace_structure_blocks",
    tooltip: "The setup and loop sections of an Arduino sketch.",
  },
  {
    type: "trace_raw_program",
    message0: "Arduino source %1",
    args0: [{ type: "field_multilinetext", name: "CODE", text: "void setup() {}\n\nvoid loop() {}" }],
    style: "trace_advanced_blocks",
    tooltip: "A complete sketch that cannot yet be separated into setup and loop blocks.",
  },
  {
    type: "trace_include",
    message0: "include %1 %2",
    args0: [
      { type: "field_dropdown", name: "STYLE", options: [["library", "ANGLE"], ["local file", "QUOTE"]] },
      { type: "field_input", name: "HEADER", text: "Arduino.h" },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_advanced_blocks",
    tooltip: "Include an Arduino library header or local header file.",
  },
  {
    type: "trace_raw_code",
    message0: "custom code %1",
    args0: [{ type: "field_multilinetext", name: "CODE", text: "// Arduino C++" }],
    previousStatement: null,
    nextStatement: null,
    style: "trace_advanced_blocks",
    tooltip: "C++ that Trace preserves when there is no matching visual block.",
  },
  {
    type: "trace_pin_mode",
    message0: "set pin %1 as %2",
    args0: [
      { type: "field_input", name: "PIN", text: "LED_BUILTIN" },
      {
        type: "field_dropdown",
        name: "MODE",
        options: [["output", "OUTPUT"], ["input", "INPUT"], ["input pull-up", "INPUT_PULLUP"]],
      },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_pin_blocks",
    tooltip: "Configure a GPIO pin before using it.",
  },
  {
    type: "trace_digital_write",
    message0: "set digital pin %1 %2",
    args0: [
      { type: "field_input", name: "PIN", text: "LED_BUILTIN" },
      { type: "field_dropdown", name: "STATE", options: [["HIGH", "HIGH"], ["LOW", "LOW"]] },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_output_blocks",
    tooltip: "Turn a digital output on or off.",
  },
  {
    type: "trace_analog_write",
    message0: "set PWM pin %1 to %2",
    args0: [
      { type: "field_input", name: "PIN", text: "2" },
      { type: "field_number", name: "VALUE", value: 128, min: 0, max: 255, precision: 1 },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_output_blocks",
    tooltip: "Write a PWM value from 0 to 255.",
  },
  {
    type: "trace_delay",
    message0: "wait %1 milliseconds",
    args0: [{ type: "field_number", name: "MILLISECONDS", value: 500, min: 0, precision: 1 }],
    previousStatement: null,
    nextStatement: null,
    style: "trace_timing_blocks",
    tooltip: "Pause the sketch for a number of milliseconds.",
  },
  {
    type: "trace_serial_begin",
    message0: "start serial at %1 baud",
    args0: [{ type: "field_number", name: "BAUD", value: 115200, min: 1, precision: 1 }],
    previousStatement: null,
    nextStatement: null,
    style: "trace_serial_blocks",
    tooltip: "Start the serial connection.",
  },
  {
    type: "trace_serial_print",
    message0: "print line %1",
    args0: [{ type: "field_input", name: "TEXT", text: "Hello from Trace" }],
    previousStatement: null,
    nextStatement: null,
    style: "trace_serial_blocks",
    tooltip: "Send a line of text to the serial console.",
  },
  {
    type: "trace_repeat",
    message0: "repeat %1 times %2 %3",
    args0: [
      { type: "field_number", name: "TIMES", value: 10, min: 0, precision: 1 },
      { type: "input_dummy" },
      { type: "input_statement", name: "DO" },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_control_blocks",
    tooltip: "Repeat the blocks inside a fixed number of times.",
  },
  {
    type: "trace_if_digital",
    message0: "if digital pin %1 is %2 %3 %4",
    args0: [
      { type: "field_input", name: "PIN", text: "4" },
      { type: "field_dropdown", name: "STATE", options: [["HIGH", "HIGH"], ["LOW", "LOW"]] },
      { type: "input_dummy" },
      { type: "input_statement", name: "DO" },
    ],
    previousStatement: null,
    nextStatement: null,
    style: "trace_control_blocks",
    tooltip: "Run blocks only while a digital input has the selected state.",
  },
];

export const arduinoToolbox = {
  kind: "categoryToolbox",
  contents: [
    {
      kind: "category",
      name: "Pins",
      colour: "#f97316",
      contents: [{ kind: "block", type: "trace_pin_mode" }],
    },
    {
      kind: "category",
      name: "Output",
      colour: "#fb923c",
      contents: [
        { kind: "block", type: "trace_digital_write" },
        { kind: "block", type: "trace_analog_write" },
      ],
    },
    {
      kind: "category",
      name: "Timing",
      colour: "#eab308",
      contents: [{ kind: "block", type: "trace_delay" }],
    },
    {
      kind: "category",
      name: "Control",
      colour: "#8b5cf6",
      contents: [
        { kind: "block", type: "trace_repeat" },
        { kind: "block", type: "trace_if_digital" },
      ],
    },
    {
      kind: "category",
      name: "Serial",
      colour: "#06b6d4",
      contents: [
        { kind: "block", type: "trace_serial_begin" },
        { kind: "block", type: "trace_serial_print" },
      ],
    },
    {
      kind: "category",
      name: "Code",
      colour: "#64748b",
      contents: [
        { kind: "block", type: "trace_include" },
        { kind: "block", type: "trace_raw_code" },
      ],
    },
  ],
};

class ArduinoGenerator extends Blockly.CodeGenerator {
  constructor() {
    super("Arduino");
    this.INDENT = "  ";
  }

  override scrub_(block: Blockly.Block, code: string, thisOnly = false): string {
    if (thisOnly) return code;
    const nextCode = this.blockToCode(block.nextConnection?.targetBlock() ?? null);
    if (typeof nextCode === "string") return code + nextCode;
    return code + (nextCode?.[0] ?? "");
  }
}

const arduinoGenerator = new ArduinoGenerator();

function safePin(block: Blockly.Block): string {
  const value = String(block.getFieldValue("PIN") ?? "").trim();
  return /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(value) ? value : "2";
}

function integerField(block: Blockly.Block, name: string, fallback: number): number {
  const value = Number(block.getFieldValue(name));
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function nestedStatements(generator: Blockly.CodeGenerator, block: Blockly.Block, input: string): string {
  return generator.statementToCode(block, input) || `${generator.INDENT}// Add blocks here.\n`;
}

function topLevelStatements(generator: Blockly.CodeGenerator, block: Blockly.Block, input: string): string {
  const target = block.getInput(input)?.connection?.targetBlock() ?? null;
  if (!target) return "";
  const code = generator.blockToCode(target);
  return typeof code === "string" ? code : code[0];
}

function withTrailingNewline(code: string): string {
  return code.endsWith("\n") ? code : `${code}\n`;
}

function registerGenerators() {
  arduinoGenerator.forBlock.trace_program = (block, generator) => {
    const beforeSetup = topLevelStatements(generator, block, "BEFORE_SETUP");
    const setup = nestedStatements(generator, block, "SETUP");
    const betweenFunctions = topLevelStatements(generator, block, "BETWEEN_FUNCTIONS");
    const loop = nestedStatements(generator, block, "LOOP");
    const afterLoop = topLevelStatements(generator, block, "AFTER_LOOP");
    const beforeGap = beforeSetup ? `${beforeSetup}\n` : "";
    const middleGap = betweenFunctions ? `\n${betweenFunctions}\n` : "\n";
    const afterGap = afterLoop ? `\n${afterLoop}` : "";
    return `${beforeGap}void setup() {\n${setup}}\n${middleGap}void loop() {\n${loop}}\n${afterGap}`;
  };
  arduinoGenerator.forBlock.trace_raw_program = (block) => String(block.getFieldValue("CODE") ?? "");
  arduinoGenerator.forBlock.trace_include = (block) => {
    const header = String(block.getFieldValue("HEADER") ?? "Arduino.h").trim().replace(/[<>"\r\n]/g, "");
    return block.getFieldValue("STYLE") === "QUOTE" ? `#include "${header}"\n` : `#include <${header}>\n`;
  };
  arduinoGenerator.forBlock.trace_raw_code = (block) => withTrailingNewline(String(block.getFieldValue("CODE") ?? ""));
  arduinoGenerator.forBlock.trace_pin_mode = (block) =>
    `pinMode(${safePin(block)}, ${block.getFieldValue("MODE")});\n`;
  arduinoGenerator.forBlock.trace_digital_write = (block) =>
    `digitalWrite(${safePin(block)}, ${block.getFieldValue("STATE")});\n`;
  arduinoGenerator.forBlock.trace_analog_write = (block) =>
    `analogWrite(${safePin(block)}, ${Math.min(255, integerField(block, "VALUE", 128))});\n`;
  arduinoGenerator.forBlock.trace_delay = (block) =>
    `delay(${integerField(block, "MILLISECONDS", 500)});\n`;
  arduinoGenerator.forBlock.trace_serial_begin = (block) =>
    `Serial.begin(${block.getFieldValue("BAUD")});\n`;
  arduinoGenerator.forBlock.trace_serial_print = (block) =>
    `Serial.println(${JSON.stringify(String(block.getFieldValue("TEXT") ?? ""))});\n`;
  arduinoGenerator.forBlock.trace_repeat = (block, generator) => {
    const times = integerField(block, "TIMES", 10);
    const variable = `count_${block.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "loop"}`;
    return `for (int ${variable} = 0; ${variable} < ${times}; ${variable}++) {\n${nestedStatements(generator, block, "DO")}}\n`;
  };
  arduinoGenerator.forBlock.trace_if_digital = (block, generator) =>
    `if (digitalRead(${safePin(block)}) == ${block.getFieldValue("STATE")}) {\n${nestedStatements(generator, block, "DO")}}\n`;
}

export function registerArduinoBlocks() {
  if (registered) return;
  Blockly.setLocale(En as unknown as Record<string, string>);
  Blockly.defineBlocksWithJsonArray(blockDefinitions);
  registerGenerators();
  registered = true;
}

function connectStack(parent: Blockly.Connection | null, blocks: Blockly.BlockSvg[]) {
  let connection = parent;
  for (const block of blocks) {
    if (!connection || !block.previousConnection) break;
    connection.connect(block.previousConnection);
    connection = block.nextConnection;
  }
}

function makeBlock(workspace: Blockly.WorkspaceSvg, type: string): Blockly.BlockSvg {
  const block = workspace.newBlock(type);
  block.initSvg();
  block.render();
  return block;
}

function blocksFromStatements(workspace: Blockly.WorkspaceSvg, statements: ArduinoStatement[]): Blockly.BlockSvg[] {
  return statements.map((statement) => {
    let block: Blockly.BlockSvg;
    switch (statement.kind) {
      case "include":
        block = makeBlock(workspace, "trace_include");
        block.setFieldValue(statement.quoted ? "QUOTE" : "ANGLE", "STYLE");
        block.setFieldValue(statement.header, "HEADER");
        return block;
      case "pinMode":
        block = makeBlock(workspace, "trace_pin_mode");
        block.setFieldValue(statement.pin, "PIN");
        block.setFieldValue(statement.mode, "MODE");
        return block;
      case "digitalWrite":
        block = makeBlock(workspace, "trace_digital_write");
        block.setFieldValue(statement.pin, "PIN");
        block.setFieldValue(statement.state, "STATE");
        return block;
      case "analogWrite":
        block = makeBlock(workspace, "trace_analog_write");
        block.setFieldValue(statement.pin, "PIN");
        block.setFieldValue(statement.value, "VALUE");
        return block;
      case "delay":
        block = makeBlock(workspace, "trace_delay");
        block.setFieldValue(statement.milliseconds, "MILLISECONDS");
        return block;
      case "serialBegin":
        block = makeBlock(workspace, "trace_serial_begin");
        block.setFieldValue(String(statement.baud), "BAUD");
        return block;
      case "serialPrintln":
        block = makeBlock(workspace, "trace_serial_print");
        block.setFieldValue(statement.text, "TEXT");
        return block;
      case "repeat":
        block = makeBlock(workspace, "trace_repeat");
        block.setFieldValue(statement.times, "TIMES");
        connectStack(block.getInput("DO")?.connection ?? null, blocksFromStatements(workspace, statement.statements));
        return block;
      case "ifDigital":
        block = makeBlock(workspace, "trace_if_digital");
        block.setFieldValue(statement.pin, "PIN");
        block.setFieldValue(statement.state, "STATE");
        connectStack(block.getInput("DO")?.connection ?? null, blocksFromStatements(workspace, statement.statements));
        return block;
      case "raw":
        block = makeBlock(workspace, "trace_raw_code");
        block.setFieldValue(statement.code, "CODE");
        return block;
    }
  });
}

function lockRoot(block: Blockly.BlockSvg) {
  block.setDeletable(false);
  block.setMovable(false);
}

export function loadArduinoCode(workspace: Blockly.WorkspaceSvg, source: string) {
  const program = parseArduinoCode(source);
  Blockly.Events.disable();
  try {
    workspace.clear();
    if (program.kind === "rawProgram") {
      const raw = makeBlock(workspace, "trace_raw_program");
      raw.setFieldValue(program.code, "CODE");
      raw.moveBy(40, 36);
      lockRoot(raw);
      return;
    }

    const root = makeBlock(workspace, "trace_program");
    connectStack(root.getInput("BEFORE_SETUP")?.connection ?? null, blocksFromStatements(workspace, program.beforeSetup));
    connectStack(root.getInput("SETUP")?.connection ?? null, blocksFromStatements(workspace, program.setup));
    connectStack(root.getInput("BETWEEN_FUNCTIONS")?.connection ?? null, blocksFromStatements(workspace, program.betweenFunctions));
    connectStack(root.getInput("LOOP")?.connection ?? null, blocksFromStatements(workspace, program.loop));
    connectStack(root.getInput("AFTER_LOOP")?.connection ?? null, blocksFromStatements(workspace, program.afterLoop));
    root.moveBy(40, 36);
    lockRoot(root);
  } finally {
    Blockly.Events.enable();
  }
}

export function createStarterBlocks(workspace: Blockly.WorkspaceSvg) {
  Blockly.Events.disable();
  try {
    workspace.clear();
    const program = makeBlock(workspace, "trace_program");
    const serial = makeBlock(workspace, "trace_serial_begin");
    serial.setFieldValue("115200", "BAUD");
    const pinMode = makeBlock(workspace, "trace_pin_mode");
    pinMode.setFieldValue("LED_BUILTIN", "PIN");
    pinMode.setFieldValue("OUTPUT", "MODE");
    connectStack(program.getInput("SETUP")?.connection ?? null, [serial, pinMode]);

    const high = makeBlock(workspace, "trace_digital_write");
    high.setFieldValue("LED_BUILTIN", "PIN");
    high.setFieldValue("HIGH", "STATE");
    const waitHigh = makeBlock(workspace, "trace_delay");
    waitHigh.setFieldValue(500, "MILLISECONDS");
    const low = makeBlock(workspace, "trace_digital_write");
    low.setFieldValue("LED_BUILTIN", "PIN");
    low.setFieldValue("LOW", "STATE");
    const waitLow = makeBlock(workspace, "trace_delay");
    waitLow.setFieldValue(500, "MILLISECONDS");
    connectStack(program.getInput("LOOP")?.connection ?? null, [high, waitHigh, low, waitLow]);

    program.moveBy(40, 36);
    lockRoot(program);
  } finally {
    Blockly.Events.enable();
  }
}

export function generateArduinoCode(workspace: Blockly.WorkspaceSvg): string {
  const program = workspace.getAllBlocks(false).find((block) => block.type === "trace_program" || block.type === "trace_raw_program");
  if (!program) return "";
  arduinoGenerator.init(workspace);
  const result = arduinoGenerator.blockToCode(program, true);
  return typeof result === "string" ? result : result[0];
}
