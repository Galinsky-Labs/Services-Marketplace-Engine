export const ACCESSIBILITY_AUDIT_CONTRACT_VERSION = 1 as const;

export interface AccessibilityFinding {
  readonly rule: 'html-lang' | 'document-title' | 'single-h1' | 'heading-order' | 'img-alt' |
    'form-label' | 'button-name' | 'link-name' | 'zoom-allowed' | 'main-landmark' |
    'color-contrast';
  readonly detail: string;
}

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
};
const stripTags = (value: string): string => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const channels = [0, 2, 4].map(index => parseInt(match[1]!.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors, or null when unparseable. */
export function contrastRatio(foreground: string, background: string): number | null {
  const left = luminance(foreground);
  const right = luminance(background);
  if (left === null || right === null) return null;
  const [light, dark] = left > right ? [left, right] : [right, left];
  return Math.round((light + 0.05) / (dark + 0.05) * 100) / 100;
}

/**
 * Static WCAG-oriented audit for server-rendered HTML (status pages, email templates).
 * `colorPairs` lists foreground/background pairs used for body text; each must reach 4.5:1.
 */
export function auditHtmlAccessibility(html: string,
  colorPairs: readonly {readonly foreground: string; readonly background: string}[] = []):
  readonly AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  const source = typeof html === 'string' ? html : '';
  const htmlTag = /<html\b[^>]*>/i.exec(source)?.[0] ?? '';
  if (!attribute(htmlTag, 'lang')) findings.push({rule: 'html-lang', detail: 'html element needs a lang attribute'});
  if (stripTags(/<title>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? '').length === 0)
    findings.push({rule: 'document-title', detail: 'document needs a non-empty title'});
  if (!/<main\b/i.test(source)) findings.push({rule: 'main-landmark', detail: 'page needs a main landmark'});
  const headings = [...source.matchAll(/<h([1-6])\b/gi)].map(match => Number(match[1]));
  if (headings.filter(level => level === 1).length !== 1)
    findings.push({rule: 'single-h1', detail: 'page needs exactly one h1'});
  headings.forEach((level, index) => {
    const previous = headings[index - 1];
    if (previous !== undefined && level > previous + 1)
      findings.push({rule: 'heading-order', detail: `h${previous} is followed by h${level}`});
  });
  for (const tag of source.match(/<img\b[^>]*>/gi) ?? []) {
    if (attribute(tag, 'alt') === null) findings.push({rule: 'img-alt', detail: tag.slice(0, 80)});
  }
  const labelled = new Set([...source.matchAll(/<label\b[^>]*\bfor\s*=\s*["']?([^"'\s>]+)/gi)]
    .map(match => match[1]));
  for (const tag of source.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? []) {
    const type = attribute(tag, 'type');
    if (type === 'hidden' || type === 'submit' || type === 'button') continue;
    const id = attribute(tag, 'id');
    if (!attribute(tag, 'aria-label') && !attribute(tag, 'aria-labelledby') && !(id && labelled.has(id)))
      findings.push({rule: 'form-label', detail: tag.slice(0, 80)});
  }
  for (const match of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (stripTags(match[2] ?? '').length === 0 && !attribute(match[0], 'aria-label'))
      findings.push({rule: 'button-name', detail: match[0].slice(0, 80)});
  }
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (stripTags(match[2] ?? '').length === 0 && !attribute(match[0], 'aria-label'))
      findings.push({rule: 'link-name', detail: match[0].slice(0, 80)});
  }
  const viewport = /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.exec(source)?.[0];
  const viewportContent = viewport ? attribute(viewport, 'content') ?? '' : '';
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewportContent))
    findings.push({rule: 'zoom-allowed', detail: 'viewport must not disable zoom'});
  for (const pair of colorPairs) {
    const ratio = contrastRatio(pair.foreground, pair.background);
    if (ratio === null || ratio < 4.5)
      findings.push({rule: 'color-contrast', detail: `${pair.foreground} on ${pair.background} is ${ratio ?? 'invalid'}`});
  }
  return Object.freeze(findings.map(finding => Object.freeze(finding)));
}
