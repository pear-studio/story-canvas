const prohibitedLineStart = new Set([..."，。！？：；、,.!?:;)]}》〉】〕）”’…"]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function characterWidth(character) {
  return /^[\x00-\xff]$/.test(character) ? 0.56 : 1;
}

export function letteringInsets(kind, fontSize) {
  if (kind === "balloon") return { x: fontSize * 0.45, y: fontSize * 0.42 };
  if (kind === "caption") return { x: fontSize * 0.45, y: fontSize * 0.38 };
  return { x: fontSize * 0.18, y: fontSize * 0.18 };
}

export function wrapHorizontalText(text, capacity) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = ""; let width = 0;
    for (const character of [...paragraph]) {
      const nextWidth = characterWidth(character);
      if (line && width + nextWidth > capacity + 1e-9) {
        if (prohibitedLineStart.has(character) && [...line].length > 1) {
          const characters = [...line]; const companion = characters.pop();
          lines.push(characters.join("")); line = companion; width = characterWidth(companion);
        } else if (!prohibitedLineStart.has(character)) {
          lines.push(line); line = ""; width = 0;
        }
      }
      line += character; width += nextWidth;
    }
    lines.push(line || " ");
  }
  return lines;
}

function lineWidth(line) {
  return [...line].reduce((total, character) => total + characterWidth(character), 0);
}

export function resolveLetteringLayout({ text, direction, kind, fontSize, canvasWidth, canvasHeight, box }) {
  const pixelFontSize = canvasWidth * fontSize / 1024;
  const insets = letteringInsets(kind, pixelFontSize);
  const lineHeight = pixelFontSize * 1.3;
  if (direction === "vertical") {
    const availableHeight = Math.max(0, 1 - box.y) * canvasHeight;
    const requestedHeight = clamp(box.h, 0.05, Math.max(0.05, 1 - box.y)) * canvasHeight;
    const minimumHeight = pixelFontSize * 3 + insets.y * 2;
    const maximumHeight = Math.min(availableHeight, Math.max(requestedHeight, minimumHeight));
    const rows = Math.max(1, Math.floor(Math.max(pixelFontSize, maximumHeight - insets.y * 2) / pixelFontSize));
    const characters = [...String(text).replaceAll("\n", "")];
    const columns = [];
    for (let index = 0; index < characters.length; index += rows) columns.push(characters.slice(index, index + rows));
    if (!columns.length) columns.push([" "]);
    const contentHeight = Math.max(...columns.map((column) => column.length)) * pixelFontSize;
    const pixelWidth = columns.length * lineHeight + insets.x * 2;
    const width = pixelWidth / canvasWidth;
    const height = Math.min(maximumHeight, contentHeight + insets.y * 2) / canvasHeight;
    return {
      box: { x: box.x, y: box.y, w: Math.min(width, Math.max(0, 1 - box.x)), h: height },
      lines: [], columns,
      overflow: pixelWidth > (1 - box.x) * canvasWidth + 1 || contentHeight + insets.y * 2 > maximumHeight + 1,
    };
  }

  const availableWidth = Math.max(0, 1 - box.x) * canvasWidth;
  const requestedWidth = clamp(box.w, 0.08, Math.max(0.08, 1 - box.x)) * canvasWidth;
  const minimumWidth = pixelFontSize * 3.2 + insets.x * 2;
  const unwrappedWidths = String(text).split("\n").map(lineWidth);
  const preferredContentWidth = Math.max(...unwrappedWidths) * pixelFontSize + insets.x * 2;
  const orphanTolerance = pixelFontSize * 0.5;
  const preferredWidth = preferredContentWidth <= requestedWidth + orphanTolerance ? preferredContentWidth : requestedWidth;
  const maximumWidth = Math.min(availableWidth, Math.max(preferredWidth, minimumWidth));
  const capacity = Math.max(1, (maximumWidth - insets.x * 2) / pixelFontSize);
  const lines = wrapHorizontalText(text, capacity);
  const contentWidth = Math.max(...lines.map(lineWidth)) * pixelFontSize;
  const width = Math.min(maximumWidth, contentWidth + insets.x * 2) / canvasWidth;
  const pixelHeight = lines.length * lineHeight + insets.y * 2;
  const height = pixelHeight / canvasHeight;
  return {
    box: { x: box.x, y: box.y, w: width, h: Math.min(height, Math.max(0, 1 - box.y)) },
    lines, columns: [],
    overflow: contentWidth + insets.x * 2 > maximumWidth + 1 || pixelHeight > (1 - box.y) * canvasHeight + 1,
  };
}

export function resizeLetteringBox(box, renderedBox, direction, dx, dy) {
  const next = { ...box };
  if (direction === "vertical") next.h = clamp(renderedBox.h + dy, 0.05, 1 - box.y);
  else next.w = clamp(renderedBox.w + dx, 0.08, 1 - box.x);
  return next;
}

export function canvasDimensions(canvas = "2:3") {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(canvas);
  const width = 1024;
  if (!match) return { width, height: 1536 };
  return { width, height: width * Number(match[2]) / Number(match[1]) };
}
