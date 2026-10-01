import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Storage can be unavailable (private windows, blocked site data); callers only keep conveniences in it.
export function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Losing a remembered selection is harmless.
  }
}

const hues = [250, 205, 165, 135, 85, 45, 15, 330, 290];
/** Stable avatar tint for an Agent or group ID. */
export function hueOf(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hues[Math.abs(hash) % hues.length]!;
}
