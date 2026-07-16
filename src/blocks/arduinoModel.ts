export type PinMode = "OUTPUT" | "INPUT" | "INPUT_PULLUP";
export type DigitalState = "HIGH" | "LOW";

export type ArduinoStatement =
  | { kind: "include"; header: string; quoted: boolean }
  | { kind: "pinMode"; pin: string; mode: PinMode }
  | { kind: "digitalWrite"; pin: string; state: DigitalState }
  | { kind: "analogWrite"; pin: string; value: number }
  | { kind: "delay"; milliseconds: number }
  | { kind: "serialBegin"; baud: number }
  | { kind: "serialPrintln"; text: string }
  | { kind: "repeat"; times: number; statements: ArduinoStatement[] }
  | { kind: "ifDigital"; pin: string; state: DigitalState; statements: ArduinoStatement[] }
  | { kind: "raw"; code: string };

export type ArduinoProgram =
  | {
      kind: "structured";
      beforeSetup: ArduinoStatement[];
      setup: ArduinoStatement[];
      betweenFunctions: ArduinoStatement[];
      loop: ArduinoStatement[];
      afterLoop: ArduinoStatement[];
    }
  | { kind: "rawProgram"; code: string };

interface FunctionRegion {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

function maskCommentsAndStrings(source: string): string {
  const output = [...source];
  let state: "code" | "lineComment" | "blockComment" | "string" | "char" = "code";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (character === "/" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "lineComment";
        index += 1;
      } else if (character === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "blockComment";
        index += 1;
      } else if (character === '"') {
        output[index] = " ";
        state = "string";
        escaped = false;
      } else if (character === "'") {
        output[index] = " ";
        state = "char";
        escaped = false;
      }
      continue;
    }

    if (character !== "\n" && character !== "\r") output[index] = " ";
    if (state === "lineComment" && character === "\n") state = "code";
    else if (state === "blockComment" && character === "*" && next === "/") {
      output[index + 1] = " ";
      state = "code";
      index += 1;
    } else if (state === "string" || state === "char") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if ((state === "string" && character === '"') || (state === "char" && character === "'")) state = "code";
    }
  }

  return output.join("");
}

function closingBrace(masked: string, openingBrace: number): number | null {
  let depth = 0;
  for (let index = openingBrace; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function findFunction(source: string, name: "setup" | "loop"): FunctionRegion | null {
  const masked = maskCommentsAndStrings(source);
  const pattern = new RegExp(`\\bvoid\\s+${name}\\s*\\(\\s*\\)\\s*\\{`, "g");
  for (const match of masked.matchAll(pattern)) {
    const start = match.index ?? 0;
    let depth = 0;
    for (let index = 0; index < start; index += 1) {
      if (masked[index] === "{") depth += 1;
      else if (masked[index] === "}") depth -= 1;
    }
    if (depth !== 0) continue;
    const openingBrace = start + match[0].lastIndexOf("{");
    const bodyEnd = closingBrace(masked, openingBrace);
    if (bodyEnd === null) return null;
    return { start, bodyStart: openingBrace + 1, bodyEnd, end: bodyEnd + 1 };
  }
  return null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function readComment(source: string, start: number): number | null {
  if (source.startsWith("//", start)) {
    const newline = source.indexOf("\n", start + 2);
    return newline === -1 ? source.length : newline;
  }
  if (source.startsWith("/*", start)) {
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  }
  return null;
}

function readChunk(source: string, start: number): number {
  const commentEnd = readComment(source, start);
  if (commentEnd !== null) return commentEnd;

  if (source[start] === "#") {
    const newline = source.indexOf("\n", start + 1);
    return newline === -1 ? source.length : newline;
  }

  const masked = maskCommentsAndStrings(source.slice(start));
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let sawBrace = false;

  for (let relative = 0; relative < masked.length; relative += 1) {
    const character = masked[relative];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") {
      braces += 1;
      sawBrace = true;
    } else if (character === "}") {
      braces = Math.max(0, braces - 1);
      if (sawBrace && braces === 0 && parentheses === 0 && brackets === 0) {
        let next = skipWhitespace(source, start + relative + 1);
        if (source.slice(next, next + 4) === "else") continue;
        if (source[next] === ";") next += 1;
        return next;
      }
    } else if (character === ";" && braces === 0 && parentheses === 0 && brackets === 0) {
      return start + relative + 1;
    }
  }
  return source.length;
}

function decodeCppString(value: string): string | null {
  try {
    return JSON.parse(value) as string;
  } catch {
    return null;
  }
}

function parseControlBody(chunk: string): { header: string; body: string } | null {
  const masked = maskCommentsAndStrings(chunk);
  const openingBrace = masked.indexOf("{");
  if (openingBrace === -1) return null;
  const end = closingBrace(masked, openingBrace);
  if (end === null || chunk.slice(end + 1).trim()) return null;
  return { header: chunk.slice(0, openingBrace).trim(), body: chunk.slice(openingBrace + 1, end) };
}

function parseChunk(chunk: string): ArduinoStatement {
  const code = chunk.trim();
  let match = code.match(/^#\s*include\s*([<"])([^>"]+)[>"]$/);
  if (match) return { kind: "include", header: match[2].trim(), quoted: match[1] === '"' };

  match = code.match(/^pinMode\s*\(\s*([A-Za-z_]\w*|\d+)\s*,\s*(OUTPUT|INPUT|INPUT_PULLUP)\s*\)\s*;$/);
  if (match) return { kind: "pinMode", pin: match[1], mode: match[2] as PinMode };

  match = code.match(/^digitalWrite\s*\(\s*([A-Za-z_]\w*|\d+)\s*,\s*(HIGH|LOW)\s*\)\s*;$/);
  if (match) return { kind: "digitalWrite", pin: match[1], state: match[2] as DigitalState };

  match = code.match(/^analogWrite\s*\(\s*([A-Za-z_]\w*|\d+)\s*,\s*(\d+)\s*\)\s*;$/);
  if (match) return { kind: "analogWrite", pin: match[1], value: Number(match[2]) };

  match = code.match(/^delay\s*\(\s*(\d+)\s*\)\s*;$/);
  if (match) return { kind: "delay", milliseconds: Number(match[1]) };

  match = code.match(/^Serial\.begin\s*\(\s*(\d+)\s*\)\s*;$/);
  if (match) return { kind: "serialBegin", baud: Number(match[1]) };

  match = code.match(/^Serial\.println\s*\(\s*((?:"(?:\\.|[^"\\])*")|(?:F\s*\(\s*"(?:\\.|[^"\\])*"\s*\)))\s*\)\s*;$/s);
  if (match) {
    const literal = match[1].startsWith("F") ? match[1].slice(match[1].indexOf('"'), match[1].lastIndexOf('"') + 1) : match[1];
    const text = decodeCppString(literal);
    if (text !== null) return { kind: "serialPrintln", text };
  }

  const control = parseControlBody(code);
  if (control) {
    match = control.header.match(/^for\s*\(\s*int\s+([A-Za-z_]\w*)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*\1\s*\+\+\s*\)$/);
    if (match) return { kind: "repeat", times: Number(match[2]), statements: parseStatements(control.body) };

    match = control.header.match(/^if\s*\(\s*digitalRead\s*\(\s*([A-Za-z_]\w*|\d+)\s*\)\s*==\s*(HIGH|LOW)\s*\)$/);
    if (match) return {
      kind: "ifDigital",
      pin: match[1],
      state: match[2] as DigitalState,
      statements: parseStatements(control.body),
    };
  }

  return { kind: "raw", code };
}

export function parseStatements(source: string): ArduinoStatement[] {
  const statements: ArduinoStatement[] = [];
  let index = 0;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) break;
    const end = readChunk(source, index);
    if (end <= index) break;
    statements.push(parseChunk(source.slice(index, end)));
    index = end;
  }
  return statements;
}

export function parseArduinoCode(source: string): ArduinoProgram {
  const setup = findFunction(source, "setup");
  const loop = findFunction(source, "loop");
  if (!setup || !loop || setup.start > loop.start || setup.end > loop.start) {
    return { kind: "rawProgram", code: source };
  }

  return {
    kind: "structured",
    beforeSetup: parseStatements(source.slice(0, setup.start)),
    setup: parseStatements(source.slice(setup.bodyStart, setup.bodyEnd)),
    betweenFunctions: parseStatements(source.slice(setup.end, loop.start)),
    loop: parseStatements(source.slice(loop.bodyStart, loop.bodyEnd)),
    afterLoop: parseStatements(source.slice(loop.end)),
  };
}

