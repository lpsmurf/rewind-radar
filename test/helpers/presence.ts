// Shared presence fixtures: what ch.presenceState() looks like for a few visitors.
export const staleThenFresh = {
  'me~1': [{ name: 'ME', color: '#111' }],
  'ann~1': [
    { name: 'ANN', color: '#abc', aisle: 'entrance' },
    { name: 'ANN', color: '#abc', aisle: 'arcade', x: 40, y: 264 },
  ],
  'bob~1': [{ name: 'B'.repeat(80), color: 'red', aisle: 'new', x: 9999, y: -5 }],
} as Record<string, any[]>;
