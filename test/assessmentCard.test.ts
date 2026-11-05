import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AssessmentCard from '../src/ui/AssessmentCard.tsx';
import { SAMPLE } from './helpers/samples.ts';

describe('AssessmentCard', () => {
  it('labels the steps as unverified README content', () => {
    const reply: any = { assessment: { ...SAMPLE, ai_directed_text: false }, reviewed_at: new Date().toISOString() };
    const html = renderToStaticMarkup(createElement(AssessmentCard, { reply, tapes: [], onOpen() {}, onShelve() {} }));
    expect(html).toContain('STEPS · FROM THE README, UNVERIFIED');
    expect(html).toContain('docker compose up -d');
  });
});
