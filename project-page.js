const escapeHtml = value => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const inlineMarkdown = value => escapeHtml(value)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

function splitTableRow(line) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim());
}

function renderTable(lines, start) {
  const header = splitTableRow(lines[start]);
  let i = start + 2;
  const rows = [];

  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }

  const html = [
    "<table>",
    "<thead><tr>",
    ...header.map(cell => `<th>${inlineMarkdown(cell)}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...rows.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`),
    "</tbody>",
    "</table>",
  ];

  return { html: html.join("\n"), next: i };
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let listType = null;
  let inCode = false;
  let codeLines = [];

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line) {
      closeList();
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(rawLine) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      closeList();
      const table = renderTable(lines, i);
      html.push(table.html);
      i = table.next - 1;
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();

    if (/^---+$/.test(line)) {
      html.push("<hr>");
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else {
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }

  closeList();

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return html.join("\n");
}

async function loadDescription() {
  const target = document.querySelector("[data-markdown]");
  const source = target.dataset.markdown;
  const response = await fetch(source);
  const markdown = await response.text();
  target.innerHTML = renderMarkdown(markdown);
}

loadDescription().catch(error => {
  document.querySelector("[data-markdown]").innerHTML =
    `<p class="notice">Could not load project notes: ${escapeHtml(error.message)}</p>`;
});
