import type { PrimeApi } from '../shared/api';

declare global {
  interface Window {
    prime: PrimeApi;
  }
}

export {};
