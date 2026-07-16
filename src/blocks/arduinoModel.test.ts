import { describe, expect, it } from "vitest";
import { parseArduinoCode, parseStatements, type ArduinoStatement } from "./arduinoModel";

function flatten(statements: ArduinoStatement[]): ArduinoStatement[] {
  return statements.flatMap((statement) => {
    if (statement.kind === "repeat" || statement.kind === "ifDigital" || statement.kind === "while" || statement.kind === "for" || statement.kind === "function") {
      return [statement, ...flatten(statement.statements)];
    }
    if (statement.kind === "if") return [statement, ...flatten(statement.statements), ...flatten(statement.elseStatements)];
    return [statement];
  });
}

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
      { kind: "declaration", typeName: "const int", name: "LED", initializer: "2" },
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

  it("turns library calls and general while loops into individual blocks", () => {
    const statements = parseStatements(`
      display.drawPixel(x, y, ST77XX_RED);
      while (Serial.available()) {
        Serial.read();
      }
    `);

    expect(statements).toEqual([
      { kind: "call", callee: "display.drawPixel", arguments: "x, y, ST77XX_RED" },
      {
        kind: "while",
        condition: "Serial.available()",
        statements: [{ kind: "call", callee: "Serial.read", arguments: "" }],
      },
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
    expect(program.beforeSetup).toEqual([{ kind: "comment", text: "before", block: false }]);
    expect(program.betweenFunctions).toEqual([{ kind: "declaration", typeName: "int", name: "between", initializer: "1" }]);
    expect(program.afterLoop).toEqual([{
      kind: "function",
      returnType: "void",
      name: "helper",
      parameters: "",
      statements: [{ kind: "serialPrintln", text: "ok" }],
    }]);
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
    expect(program.beforeSetup[1]).toEqual({
      kind: "declaration",
      typeName: "const char *",
      name: "text",
      initializer: '"void loop() {}"',
    });
  });

  it("translates macros, object construction, assignment, and return separately", () => {
    const statements = parseStatements(`#define TFT_CS 7
SPIClass spi(FSPI);
Adafruit_ST7735 tft = Adafruit_ST7735(&spi, TFT_CS, TFT_DC, TFT_RST);
brightness += 10;
return brightness;
counter++;
`);

    expect(statements).toEqual([
      { kind: "directive", directive: "define TFT_CS 7" },
      { kind: "declaration", typeName: "SPIClass", name: "spi", initializer: "(FSPI)" },
      {
        kind: "declaration",
        typeName: "Adafruit_ST7735",
        name: "tft",
        initializer: "Adafruit_ST7735(&spi, TFT_CS, TFT_DC, TFT_RST)",
      },
      { kind: "assignment", target: "brightness", operator: "+=", value: "10" },
      { kind: "return", value: "brightness" },
      { kind: "update", target: "counter", operator: "++", prefix: false },
    ]);
  });

  it("translates generic if/else and for control structures", () => {
    const statements = parseStatements(`if (temperature > limit) {
  fan.start();
} else {
  fan.stop();
}
for (size_t i = 1; i <= count; i += 2) {
  samples[i] = analogRead(A0);
}
`);

    expect(statements).toEqual([
      {
        kind: "if",
        condition: "temperature > limit",
        statements: [{ kind: "call", callee: "fan.start", arguments: "" }],
        elseStatements: [{ kind: "call", callee: "fan.stop", arguments: "" }],
      },
      {
        kind: "for",
        initializer: "size_t i = 1",
        condition: "i <= count",
        update: "i += 2",
        statements: [{ kind: "assignment", target: "samples[i]", operator: "=", value: "analogRead(A0)" }],
      },
    ]);
  });

  it("translates a realistic display sketch without unparsed statement blocks", () => {
    const program = parseArduinoCode(`#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#define TFT_CS 7
#define TFT_DC 5
#define TFT_RST 6

SPIClass spi(FSPI);
Adafruit_ST7735 tft = Adafruit_ST7735(&spi, TFT_CS, TFT_DC, TFT_RST);

void setup() {
  Serial.begin(115200);
  spi.begin(12, -1, 11, TFT_CS);
  tft.initR(INITR_BLACKTAB);
  tft.fillScreen(ST77XX_BLACK);
}

void loop() {
  if (millis() > 1000) {
    tft.setCursor(0, 0);
    tft.println("Trace");
  }
}
`);

    expect(program.kind).toBe("structured");
    if (program.kind !== "structured") return;
    const all = flatten([...program.beforeSetup, ...program.setup, ...program.loop, ...program.afterLoop]);
    expect(all.filter((statement) => statement.kind === "raw")).toEqual([]);
    expect(all.filter((statement) => statement.kind === "call")).toHaveLength(5);
  });
});
