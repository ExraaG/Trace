import * as Blockly from "blockly/core";
import { describe, expect, it } from "vitest";
import { createArduinoBlockState, registerArduinoBlocks } from "./arduino";

describe("Arduino Blockly connections", () => {
  it("connects generated statement blocks into every program section", () => {
    registerArduinoBlocks();
    const workspace = new Blockly.Workspace();
    const program = workspace.newBlock("trace_program");
    const first = workspace.newBlock("trace_include");
    const second = workspace.newBlock("trace_include");

    expect(program.getInput("BEFORE_SETUP")?.connection?.connect(first.previousConnection!)).toBe(true);
    expect(first.nextConnection?.connect(second.previousConnection!)).toBe(true);
    expect(program.getInputTargetBlock("BEFORE_SETUP")).toBe(first);
    expect(first.getNextBlock()).toBe(second);

    workspace.dispose();
  });

  it("serializes a large pasted sketch as one connected root", () => {
    const includes = Array.from({ length: 80 }, (_, index) => `#include <Library${index}.h>`).join("\n");
    const source = `${includes}
const int LED_PIN = 2;
void helper() { digitalWrite(LED_PIN, HIGH); }
void setup() { pinMode(LED_PIN, OUTPUT); }
void loop() { helper(); delay(10); }
`;
    const state = createArduinoBlockState(source);
    const workspace = new Blockly.Workspace();
    const root = Blockly.serialization.blocks.append(state, workspace);

    expect(workspace.getTopBlocks(false)).toEqual([root]);
    let beforeCount = 0;
    let current = root.getInputTargetBlock("BEFORE_SETUP");
    while (current) {
      beforeCount += 1;
      current = current.getNextBlock();
    }
    expect(beforeCount).toBe(82);
    expect(root.getInputTargetBlock("SETUP")?.type).toBe("trace_pin_mode");
    expect(root.getInputTargetBlock("LOOP")?.type).toBe("trace_call");

    workspace.dispose();
  });
});
