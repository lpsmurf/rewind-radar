import type { Visitor } from '../types';

const COLORS = ['#ff4d6d', '#3ddc84', '#4aa3ff', '#ff9f1c', '#c77dff', '#00e5ff', '#ff6bd6', '#b8ff3d'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function randId(): string {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}

export function getVisitor(): Visitor {
  let id = '';
  try {
    id = localStorage.getItem('rr_visitor') || '';
    if (!id) {
      id = randId();
      localStorage.setItem('rr_visitor', id);
    }
  } catch {
    id = randId();
  }
  return {
    id,
    name: 'GUEST-' + id.slice(0, 4).toUpperCase(),
    color: COLORS[hash(id) % COLORS.length],
    aisle: 'entrance',
  };
}
