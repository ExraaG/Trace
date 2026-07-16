import { describe, expect, it } from "vitest";
import { parseArduinoCode, parseStatements } from "./arduinoModel";

describe("Arduino code to blocks model", () => {
  it("turns a normal sketch into structured setup and loop statements", () => {
    const program = parseArduinoCode(`#include <SPI.h>
const int LED = 2;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
}
`);

    expect(program.kind).toBe("structured");
    if (program.kind !== "structured") return;
    expect(program.beforeSetup).toEqual([
      { kind: "include", header: "SPI.h", quoted: false },
      { kind: "raw", code: "const int LED = 2;" },
    ]);
    expect(program.setup).toEqual([
      { kind: "serialBegin", baud: 115200 },
      { kind: "pinMode", pin: "LED", mode: "OUTPUT" },
    ]);
    expect(program.loop).toEqual([
      { kind: "digitalWrite", pin: "LED", state: "HIGH" },
      { kind: "delay", milliseconds: 500 },
      { kind: "digitalWrite", pin: "LED", state: "LOW" },
    ]);
  });

  it("parses nested repeat and digital condition blocks", () => {
    const statements = parseStatements(`
      for (int index = 0; index < 3; index++) {
        if (digitalRead(4) == LOW) {
          analogWrite(2, 128);
          delay(20);
        }
      }
    `);

    expect(statements).toEqual([{
      kind: "repeat",
      times: 3,
      statements: [{
        kind: "ifDigital",
        pin: "4",
        state: "LOW",
        statements: [
          { kind: "analogWrite", pin: "2", value: 128 },
          { kind: "delay", milliseconds: 20 },
        ],
      }],
    }]);
  });

  it("keeps unsupported C++ as visible custom-code blocks", () => {
    const statements = parseStatements(`
      display.drawPixel(x, y, ST77XX_RED);
      while (Serial.available()) {
        Serial.read();
      }
    `);

    expect(statements).toEqual([
      { kind: "raw", code: "display.drawPixel(x, y, ST77XX_RED);" },
      { kind: "raw", code: "while (Serial.available()) {\n        Serial.read();\n      }" },
    ]);
  });

  it("preserves code around both Arduino functions", () => {
    const program = parseArduinoCode(`// before
void setup() {}
int between = 1;
void loop() {}
void helper() { Serial.println("ok"); }
`);

    expect(program.kind).toBe("structured");
    if (program.kind !== "structured") return;
    expect(program.beforeSetup).toEqual([{ kind: "raw", code: "// before" }]);
    expect(program.betweenFunctions).toEqual([{ kind: "raw", code: "int between = 1;" }]);
    expect(program.afterLoop).toEqual([{ kind: "raw", code: 'void helper() { Serial.println("ok"); }' }]);
  });

  it("uses a full-source block while code is incomplete", () => {
    const source = "void setup() {\n  pinMode(2, OUTPUT);";
    expect(parseArduinoCode(source)).toEqual({ kind: "rawProgram", code: source });
  });

  it("does not mistake setup text inside comments or strings for functions", () => {
    const source = `// void setup() {}
const char *text = "void loop() {}";
void setup() {}
void loop() {}
`;
    const program = parseArduinoCode(source);
    expect(program.kind).toBe("structured");
    if (program.kind !== "structured") return;
    expect(program.beforeSetup).toHaveLength(2);
  });
});

