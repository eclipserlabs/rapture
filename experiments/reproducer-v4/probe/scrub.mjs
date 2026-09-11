// Shared comment scrubber.
//
// Service sources carry RESEARCH annotations: the issue number, the fixing
// revision sha, and a plain-language root-cause explanation. A contiguous run of
// `//` lines is treated as one block: if ANY line in the block mentions the
// historical bug the WHOLE block is dropped, because continuation lines carry
// the explanation without repeating the sha. Only comments are touched; no
// executable line is altered.
export const LEAKY_COMMENT = /historical|buggy|fixed\s|regression|\bHL_[A-Z0-9_]+|#\d{3,}|\b[0-9a-f]{7,40}\b|oracle|capture|replay|incident|V[23](\.\d)?\b/i;
export function scrubComments(src) {
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let inBlock = false;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; i += 1; continue; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; i += 1; continue; }
    if (t.startsWith("//")) {
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("//")) j += 1;
      const block = lines.slice(i, j);
      if (!block.some((b) => LEAKY_COMMENT.test(b))) out.push(...block);
      i = j;
      continue;
    }
    const k = lines[i].indexOf("//");
    if (k > 0 && LEAKY_COMMENT.test(lines[i].slice(k))) out.push(lines[i].slice(0, k).replace(/\s+$/, ""));
    else out.push(lines[i]);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
