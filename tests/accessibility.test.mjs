import test from 'node:test';
import assert from 'node:assert/strict';
import {auditHtmlAccessibility, contrastRatio} from '../packages/contracts/dist/accessibility-audit.js';
import {STATUS_PAGE_COLORS, adapterStatuses, createMemoryApp, renderStatusPage, renderTemplate} from '../apps/api/dist/index.js';

test('the service status page passes the accessibility audit', () => {
  const {services} = createMemoryApp();
  const html = renderStatusPage(services.config.version, adapterStatuses(services));
  assert.deepEqual(auditHtmlAccessibility(html, STATUS_PAGE_COLORS), []);
});

test('the audit detects common WCAG failures', () => {
  const findings = auditHtmlAccessibility(`<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head>
<body><h1>A</h1><h3>B</h3><h1>C</h1><img src="x.png"><input id="q"><button></button><a href="/x"></a></body></html>`,
  [{foreground: '#777777', background: '#ffffff'}]);
  assert.deepEqual([...new Set(findings.map(finding => finding.rule))].sort(), ['button-name', 'color-contrast',
    'document-title', 'form-label', 'heading-order', 'html-lang', 'img-alt', 'link-name', 'main-landmark',
    'single-h1', 'zoom-allowed']);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#fff', '#000'), null);
  const labelled = auditHtmlAccessibility('<html lang="en"><title>t</title><main><h1>x</h1><label for="q">Q</label><input id="q"><input type="hidden"><button aria-label="Close"></button></main></html>');
  assert.deepEqual(labelled, []);
});

test('notification templates are plain text with a descriptive link and no personal data', () => {
  for (const key of ['lead.received', 'quote.received', 'job-room.message', 'generic.update']) {
    const message = renderTemplate(key, 'ref-1', 'https://app.example.org/');
    assert.ok(message.subject.length > 0 && message.subject.length <= 78);
    assert.match(message.text, /https:\/\/app\.example\.org\/r\/ref-1$/);
    assert.equal(/<[^>]+>/.test(message.text), false);
  }
  assert.equal(renderTemplate('unknown', 'ref', 'https://app.example.org'), null);
});
