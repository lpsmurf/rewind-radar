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

/** GitHub username remembered after a profile scan (enables the FIT check). */
export function getGithub(): string | null {
  try {
    return localStorage.getItem('rr_github') || null;
  } catch {
    return null;
  }
}

export function setGithub(u: string): void {
  try {
    localStorage.setItem('rr_github', u);
  } catch {
    /* storage blocked */
  }
}

export function clearGithub(): void {
  try {
    localStorage.removeItem('rr_github');
  } catch {
    /* storage blocked */
  }
}
